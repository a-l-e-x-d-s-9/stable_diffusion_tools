"""Cached YuNet detection with optional ONNX Runtime CUDA acceleration.

Model and decoding reference: OpenCV Zoo's MIT-licensed 2023 YuNet and
https://github.com/opencv/opencv/blob/4.x/modules/objdetect/src/face_detect.cpp
"""
import hashlib
import ctypes
import importlib.util
from pathlib import Path
import sys
import tempfile
import threading
import urllib.request

import cv2
import numpy as np


MODEL_NAME = 'face_detection_yunet_2023mar.onnx'
MODEL_URL = ('https://media.githubusercontent.com/media/opencv/opencv_zoo/main/'
             'models/face_detection_yunet/' + MODEL_NAME)
MODEL_SHA256 = '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4'
DEFAULT_MODEL = Path(__file__).resolve().parent / '.models' / MODEL_NAME


def preload_nvidia_libraries():
    """ORT 1.20 lacks preload_dlls; PyTorch loads only some cuDNN components."""
    if not sys.platform.startswith('linux'):
        return
    packages = {
        'cuda_nvrtc': ('libnvrtc.so.12',),
        'cudnn': tuple(f'libcudnn_{part}.so.9' for part in (
            'graph', 'ops', 'adv', 'cnn', 'engines_precompiled',
            'engines_runtime_compiled', 'heuristic')),
    }
    for package, names in packages.items():
        try:
            spec = importlib.util.find_spec(f'nvidia.{package}')
        except ModuleNotFoundError:
            continue
        if spec is None or not spec.submodule_search_locations:
            continue
        for location in spec.submodule_search_locations:
            for name in names:
                path = Path(location) / 'lib' / name
                if path.is_file():
                    ctypes.CDLL(str(path), mode=ctypes.RTLD_GLOBAL)


def ensure_model(path: Path):
    """Download only the default model; custom paths must already exist."""
    if path.is_file():
        return
    if path.resolve() != DEFAULT_MODEL.resolve():
        raise FileNotFoundError(f'YuNet model not found: {path}')
    path.parent.mkdir(parents=True, exist_ok=True)
    print(f'Downloading YuNet (227 KB) to {path} ...')
    temporary = None
    try:
        with urllib.request.urlopen(MODEL_URL, timeout=30) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != MODEL_SHA256:
            raise RuntimeError('Downloaded YuNet model checksum does not match.')
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(data)
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def decode_outputs(outputs, size, min_conf, nms_threshold):
    """Decode YuNet's three feature scales into OpenCV's [N, 15] format."""
    candidates = []
    for stride in (8, 16, 32):
        scores = np.sqrt(np.clip(outputs[f'cls_{stride}'].reshape(-1), 0, 1) *
                         np.clip(outputs[f'obj_{stride}'].reshape(-1), 0, 1))
        indices = np.flatnonzero(scores >= min_conf)
        if not len(indices):
            continue
        grid = np.column_stack((indices % (size // stride), indices // (size // stride)))
        boxes = outputs[f'bbox_{stride}'].reshape(-1, 4)[indices]
        centers = (grid + boxes[:, :2]) * stride
        sizes = np.exp(boxes[:, 2:]) * stride
        landmarks = outputs[f'kps_{stride}'].reshape(-1, 5, 2)[indices]
        landmarks = (landmarks + grid[:, None, :]) * stride
        rows = np.column_stack((centers - sizes / 2, sizes,
                                landmarks.reshape(-1, 10), scores[indices]))
        candidates.append(rows)
    if not candidates:
        return np.empty((0, 15), dtype=np.float32)
    rows = np.concatenate(candidates).astype(np.float32)
    # Match OpenCV's integer-box NMS to keep CPU and CUDA behavior consistent.
    keep = cv2.dnn.NMSBoxes(rows[:, :4].astype(int).tolist(), rows[:, 14].tolist(),
                           min_conf, nms_threshold, top_k=5000)
    return rows[np.asarray(keep, dtype=int).reshape(-1)]


class YuNetDetector:
    """One shared GPU session, or one lightweight OpenCV detector per worker."""
    def __init__(self, model_path=DEFAULT_MODEL, device='auto', min_conf=0.9,
                 nms_threshold=0.4):
        self.model_path = Path(model_path)
        ensure_model(self.model_path)
        self.min_conf = min_conf
        self.nms_threshold = nms_threshold
        self.size = 640  # This model's ONNX Runtime input has a fixed shape.
        self.session = None
        self.local = threading.local()
        self.lock = threading.Lock()
        self.backend = 'OpenCV CPU'
        if device != 'cpu':
            try:
                # Import first so ORT can reuse the environment's CUDA/cuDNN libs.
                try:
                    import torch  # noqa: F401
                except ImportError:
                    pass
                import onnxruntime as ort
                if 'CUDAExecutionProvider' not in ort.get_available_providers():
                    raise RuntimeError('onnxruntime-gpu is not installed')
                if hasattr(ort, 'preload_dlls'):
                    ort.preload_dlls()
                else:
                    preload_nvidia_libraries()
                options = ort.SessionOptions()
                options.intra_op_num_threads = 1
                options.inter_op_num_threads = 1
                session = ort.InferenceSession(
                    str(self.model_path), sess_options=options,
                    providers=[('CUDAExecutionProvider', {
                        'cudnn_conv_algo_search': 'HEURISTIC',
                        'cudnn_conv_use_max_workspace': '0',
                    }), 'CPUExecutionProvider'])
                if 'CUDAExecutionProvider' not in session.get_providers():
                    raise RuntimeError('CUDA provider could not initialize')
                self.input_name = session.get_inputs()[0].name
                self.output_names = [output.name for output in session.get_outputs()]
                session.run(None, {self.input_name: np.zeros((1, 3, 640, 640), np.float32)})
                self.session = session
                self.backend = 'ONNX Runtime CUDA'
            except Exception as error:
                if device == 'cuda':
                    raise RuntimeError(f'GPU detection unavailable: {error}. '
                                       'See readme_files/face_cropping.md for setup.') from error
                sys.stderr.write(f'[YuNet] GPU unavailable ({error}); using OpenCV CPU.\n')

    def detect(self, image):
        height, width = image.shape[:2]
        scale = min(self.size / width, self.size / height)
        resized_w = max(1, round(width * scale))
        resized_h = max(1, round(height * scale))
        resized = cv2.resize(image, (resized_w, resized_h))
        padded = cv2.copyMakeBorder(resized, 0, self.size - resized_h,
                                    0, self.size - resized_w, cv2.BORDER_CONSTANT)
        if self.session is not None:
            blob = cv2.dnn.blobFromImage(padded)  # BGR, raw 0..255 values.
            with self.lock:
                predictions = self.session.run(None, {self.input_name: blob})
            rows = decode_outputs(dict(zip(self.output_names, predictions)), self.size,
                                  self.min_conf, self.nms_threshold)
        else:
            detector = getattr(self.local, 'detector', None)
            if detector is None:
                detector = cv2.FaceDetectorYN.create(str(self.model_path), '',
                                                     (self.size, self.size),
                                                     self.min_conf, self.nms_threshold)
                self.local.detector = detector
            _, rows = detector.detect(padded)
            if rows is None:
                return np.empty((0, 15), dtype=np.float32)
            rows = rows.copy()
        # Undo letterboxing, including five facial landmark coordinates.
        rows[:, [0, 2, 4, 6, 8, 10, 12]] *= width / resized_w
        rows[:, [1, 3, 5, 7, 9, 11, 13]] *= height / resized_h
        return rows
