#!/usr/bin/env python3
import os
os.environ.setdefault('OPENCV_DNN_ENABLE_OPENCL', '0')
import sys
import cv2
cv2.setNumThreads(1)
try:
    cv2.ocl.setUseOpenCL(False)
except Exception:
    pass

import argparse
from pathlib import Path
from typing import List, Tuple, Dict
from dataclasses import dataclass
import concurrent.futures
import threading
from tqdm import tqdm
import numpy as np

# Optional dependency: mediapipe
_HAS_MEDIAPIPE = True
try:
    import mediapipe as mp
except Exception:
    _HAS_MEDIAPIPE = False

try:
    import common
    IMAGE_EXTS = set(common.image_extensions)
except Exception:
    IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff'}

@dataclass
class Face:
    x: int
    y: int
    w: int
    h: int
    score: float
    src: str = 'det'  # which detector: mediapipe|dnn|haar|ensemble

def clamp(val, lo, hi):
    return max(lo, min(hi, val))

def iou(boxA: Tuple[int,int,int,int], boxB: Tuple[int,int,int,int]) -> float:
    xA = max(boxA[0], boxB[0]); yA = max(boxA[1], boxB[1])
    xB = min(boxA[0] + boxA[2], boxB[0] + boxB[2]); yB = min(boxA[1] + boxA[3], boxB[1] + boxB[3])
    interW = max(0, xB - xA); interH = max(0, yB - yA)
    interArea = interW * interH
    areaA = boxA[2] * boxA[3]; areaB = boxB[2] * boxB[3]
    denom = float(areaA + areaB - interArea + 1e-6)
    return interArea / denom

def nms(faces: List[Face], iou_thresh: float) -> List[Face]:
    faces = sorted(faces, key=lambda f: f.score, reverse=True)
    keep: List[Face] = []
    for f in faces:
        if all(iou((f.x,f.y,f.w,f.h),(k.x,k.y,k.w,k.h)) < iou_thresh for k in keep):
            keep.append(f)
    return keep

def expand_box(x, y, w, h, img_w, img_h, margin_ratio: float, make_square: bool):
    cx = x + w / 2.0; cy = y + h / 2.0
    side_w = w * (1.0 + margin_ratio); side_h = h * (1.0 + margin_ratio)
    if make_square:
        side = max(side_w, side_h); side_w = side_h = side
    nx = int(round(cx - side_w / 2.0)); ny = int(round(cy - side_h / 2.0))
    nw = int(round(side_w)); nh = int(round(side_h))
    nx = clamp(nx, 0, img_w - 1); ny = clamp(ny, 0, img_h - 1)
    if nx + nw > img_w: nw = img_w - nx
    if ny + nh > img_h: nh = img_h - ny
    return nx, ny, nw, nh

# Detector: MediaPipe
def detect_faces_mediapipe(image_bgr, min_conf=0.6, model_selection=0) -> List[Face]:
    if not _HAS_MEDIAPIPE: return []
    img_h, img_w = image_bgr.shape[:2]
    rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
    mp_fd = mp.solutions.face_detection
    with mp_fd.FaceDetection(model_selection=model_selection, min_detection_confidence=min_conf) as fd:
        res = fd.process(rgb)
    out = []
    if res.detections:
        for det in res.detections:
            score = float(det.score[0]) if det.score else 0.0
            bb = det.location_data.relative_bounding_box
            x = int(bb.xmin * img_w); y = int(bb.ymin * img_h)
            w = int(bb.width * img_w); h = int(bb.height * img_h)
            if w <= 0 or h <= 0: continue
            x = clamp(x, 0, img_w - 1); y = clamp(y, 0, img_h - 1)
            if x + w > img_w: w = img_w - x
            if y + h > img_h: h = img_h - y
            out.append(Face(x, y, w, h, score, 'mediapipe'))
    return out

# Detector: DNN SSD
_DNN_LOCAL = threading.local()

def _get_dnn(model_dir: Path):
    net = getattr(_DNN_LOCAL, 'net', None)
    if net is not None: return net
    proto = str(model_dir / 'deploy.prototxt')
    caffemodel = str(model_dir / 'res10_300x300_ssd_iter_140000.caffemodel')
    if not (os.path.isfile(proto) and os.path.isfile(caffemodel)):
        setattr(_DNN_LOCAL, 'net', None)
        return None
    net = cv2.dnn.readNetFromCaffe(proto, caffemodel)
    try:
        net.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV)
        net.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU)
    except Exception:
        pass
    setattr(_DNN_LOCAL, 'net', net)
    return net

def detect_faces_dnn(image_bgr, min_conf=0.6, model_dir: Path = Path('models')) -> List[Face]:
    net = _get_dnn(model_dir)
    if net is None:
        sys.stderr.write(f'[DNN] Model files not found in {model_dir}. Expected deploy.prototxt and res10_300x300_ssd_iter_140000.caffemodel\\n')
        return []
    img_h, img_w = image_bgr.shape[:2]
    resized = cv2.resize(image_bgr, (300, 300))
    blob = cv2.dnn.blobFromImage(resized, 1.0, (300, 300), (104.0, 177.0, 123.0), swapRB=False, crop=False)
    net.setInput(blob)
    detections = net.forward()
    out = []
    for i in range(detections.shape[2]):
        score = float(detections[0, 0, i, 2])
        if score < min_conf: continue
        box = detections[0, 0, i, 3:7] * [img_w, img_h, img_w, img_h]
        x1, y1, x2, y2 = box.astype(int)
        x = clamp(min(x1, x2), 0, img_w - 1); y = clamp(min(y1, y2), 0, img_h - 1)
        w = clamp(abs(x2 - x1), 1, img_w - x); h = clamp(abs(y2 - y1), 1, img_h - y)
        out.append(Face(x, y, w, h, score, 'dnn'))
    return out

# Detector: Haar
def detect_faces_haar(image_bgr, min_size_px=256, scaleFactor=1.2, minNeighbors=8) -> List[Face]:
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    front = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
    dets = front.detectMultiScale(gray, scaleFactor=scaleFactor, minNeighbors=minNeighbors,
                                  minSize=(min_size_px, min_size_px))
    faces = [Face(int(x), int(y), int(w), int(h), 0.5, 'haar') for (x,y,w,h) in dets]
    return faces

def rotate_image(image_bgr, rot):
    if rot == 0: return image_bgr
    if rot == 90: return cv2.rotate(image_bgr, cv2.ROTATE_90_CLOCKWISE)
    if rot == 180: return cv2.rotate(image_bgr, cv2.ROTATE_180)
    if rot == 270: return cv2.rotate(image_bgr, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return image_bgr

def map_box_back(f: Face, rot: int, img_w: int, img_h: int) -> Face:
    if rot == 0: return f
    if rot == 90:
        nx = img_w - (f.y + f.h); ny = f.x; nw = f.h; nh = f.w
    elif rot == 180:
        nx = img_w - (f.x + f.w); ny = img_h - (f.y + f.h); nw = f.w; nh = f.h
    elif rot == 270:
        nx = f.y; ny = img_h - (f.x + f.w); nw = f.h; nh = f.w
    else:
        nx, ny, nw, nh = f.x, f.y, f.w, f.h
    return Face(nx, ny, nw, nh, f.score, f.src)

def detect_faces_single(image_bgr, detector: str, min_conf: float, min_size_px: int,
                        dnn_model_dir: Path, rotations: List[int], haar_scale: float, haar_neighbors: int) -> List[Face]:
    img_h, img_w = image_bgr.shape[:2]
    results: List[Face] = []
    for rot in rotations:
        rotated = rotate_image(image_bgr, rot)
        faces: List[Face] = []
        if detector in ('auto','mediapipe'):
            faces += detect_faces_mediapipe(rotated, min_conf=min_conf)
        if detector in ('auto','dnn'):
            faces += detect_faces_dnn(rotated, min_conf=min_conf, model_dir=dnn_model_dir)
        if detector in ('auto','haar'):
            faces += detect_faces_haar(rotated, min_size_px=min_size_px, scaleFactor=haar_scale, minNeighbors=haar_neighbors)
        for f in faces:
            f2 = map_box_back(f, rot, img_w, img_h)
            if f2.w >= min_size_px and f2.h >= min_size_px:
                results.append(f2)
    return results

def detect_faces_ensemble(image_bgr, min_conf: float, min_size_px: int, dnn_model_dir: Path,
                          rotations: List[int], haar_scale: float, haar_neighbors: int,
                          agree_k: int, agree_iou: float) -> List[Face]:
    # Run all three, then group by IoU and require agreement
    sources = ['mediapipe','dnn','haar']
    all_faces: List[Face] = []
    for det in sources:
        all_faces += detect_faces_single(image_bgr, det, min_conf, min_size_px, dnn_model_dir, rotations, haar_scale, haar_neighbors)
    # group
    groups: List[Dict] = []  # each: {'box':(x,y,w,h),'faces':[Face], 'srcs':set, 'score':float}
    for f in sorted(all_faces, key=lambda z: z.score, reverse=True):
        placed = False
        for g in groups:
            if iou((f.x,f.y,f.w,f.h), g['box']) >= agree_iou:
                g['faces'].append(f)
                g['srcs'].add(f.src)
                # Update box to average for better stability
                xs = [x.x for x in g['faces']]; ys = [x.y for x in g['faces']]
                ws = [x.w for x in g['faces']]; hs = [x.h for x in g['faces']]
                g['box'] = (int(np.median(xs)), int(np.median(ys)), int(np.median(ws)), int(np.median(hs)))
                g['score'] = max(g['score'], f.score)
                placed = True
                break
        if not placed:
            groups.append({'box':(f.x,f.y,f.w,f.h), 'faces':[f], 'srcs':{f.src}, 'score':f.score})
    kept = []
    for g in groups:
        if len(g['srcs']) >= agree_k:
            x,y,w,h = g['box']
            kept.append(Face(x,y,w,h, g['score'], 'ensemble'))
    return kept

def filter_and_sort_faces(faces: List[Face], img_area: int, min_frac: float,
                          aspect_lo: float, aspect_hi: float, iou_thresh: float, max_faces: int) -> List[Face]:
    out = []
    for f in faces:
        frac = (f.w * f.h) / float(img_area)
        ar = f.w / float(f.h + 1e-6)
        if frac < min_frac: continue
        if not (aspect_lo <= ar <= aspect_hi): continue
        out.append(f)
    out = nms(out, iou_thresh=iou_thresh)
    out = sorted(out, key=lambda f: (f.score, f.w * f.h), reverse=True)
    if max_faces is not None and max_faces > 0: out = out[:max_faces]
    return out

def laplacian_sharpness(img_gray) -> float:
    return float(cv2.Laplacian(img_gray, cv2.CV_64F).var())

def validate_with_facemesh(image_bgr, min_landmarks=200, min_conf=0.5) -> bool:
    if not _HAS_MEDIAPIPE: return True  # cannot validate if not available
    rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
    mp_fm = mp.solutions.face_mesh
    with mp_fm.FaceMesh(static_image_mode=True, max_num_faces=1, refine_landmarks=False,
                        min_detection_confidence=min_conf) as fm:
        res = fm.process(rgb)
    if not res.multi_face_landmarks: return False
    # simple count check
    lm = res.multi_face_landmarks[0].landmark
    return len(lm) >= min_landmarks

def crop_faces_from_image(image_path: Path, source_root: Path, target_root: Path,
                          detector: str, min_conf: float, min_size_px: int, min_frac: float,
                          aspect_lo: float, aspect_hi: float, iou_thresh: float, max_faces: int,
                          margin_ratio: float, make_square: bool, dnn_model_dir: Path,
                          rotations: List[int], haar_scale: float, haar_neighbors: int,
                          ensemble_agree_k: int, ensemble_agree_iou: float,
                          validate_mesh: bool, min_landmarks: int, min_mesh_conf: float,
                          min_sharpness: float) -> int:
    img = cv2.imread(str(image_path))
    if img is None: return 0
    img_h, img_w = img.shape[:2]

    if detector == 'ensemble':
        faces = detect_faces_ensemble(img, min_conf, min_size_px, dnn_model_dir, rotations, haar_scale, haar_neighbors,
                                      ensemble_agree_k, ensemble_agree_iou)
    else:
        faces = detect_faces_single(img, detector, min_conf, min_size_px, dnn_model_dir, rotations, haar_scale, haar_neighbors)

    faces = filter_and_sort_faces(faces, img_area=img_w * img_h, min_frac=min_frac,
                                  aspect_lo=aspect_lo, aspect_hi=aspect_hi, iou_thresh=iou_thresh,
                                  max_faces=max_faces)

    count = 0
    for idx, f in enumerate(faces):
        x, y, w, h = expand_box(f.x, f.y, f.w, f.h, img_w, img_h, margin_ratio=margin_ratio, make_square=make_square)
        crop = img[y:y+h, x:x+w]
        if crop.size == 0: continue

        # Precision validators
        if min_sharpness > 0:
            g = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
            if laplacian_sharpness(g) < min_sharpness:
                continue
        if validate_mesh:
            if not validate_with_facemesh(crop, min_landmarks=min_landmarks, min_conf=min_mesh_conf):
                continue

        rel = image_path.relative_to(source_root)
        suffix = f"_face_{idx}"
        out_path = target_root / rel.with_stem(rel.stem + suffix)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(out_path), crop)
        count += 1
    return count

def iter_images(root: Path):
    for p in root.rglob('*'):
        if p.is_file() and p.suffix.lower() in IMAGE_EXTS and '/.' not in p.as_posix():
            yield p

def parse_rotations(s: str):
    vals = []
    for tok in s.split(','):
        tok = tok.strip()
        if not tok: continue
        try:
            v = int(tok)
        except Exception:
            continue
        if v in (0, 90, 180, 270):
            vals.append(v)
    return list(dict.fromkeys(vals)) or [0]

def main():
    ap = argparse.ArgumentParser(description='Detect faces and save cropped face images.')
    ap.add_argument('--source_folder', required=True)
    ap.add_argument('--target_folder', default=None)
    ap.add_argument('--detector', default='auto', choices=['auto','mediapipe','dnn','haar','ensemble'])
    ap.add_argument('--preset', default='balanced', choices=['balanced','precision'])

    ap.add_argument('--min_conf', type=float, default=0.6)
    ap.add_argument('--min_size', type=int, default=256)
    ap.add_argument('--min_face_frac', type=float, default=0.01)
    ap.add_argument('--aspect_lo', type=float, default=0.6)
    ap.add_argument('--aspect_hi', type=float, default=1.8)
    ap.add_argument('--iou_thresh', type=float, default=0.4)
    ap.add_argument('--max_faces', type=int, default=5)
    ap.add_argument('--margin', type=float, default=0.6)
    ap.add_argument('--square', action='store_true')

    ap.add_argument('--workers', type=int, default=8)
    ap.add_argument('--force-workers', action='store_true')
    ap.add_argument('--dnn_model_dir', type=str, default='models')
    ap.add_argument('--rotations', type=str, default='0,90,270')

    # Haar tunables
    ap.add_argument('--haar_scale', type=float, default=1.2)
    ap.add_argument('--haar_neighbors', type=int, default=8)

    # Ensemble parameters
    ap.add_argument('--agree_k', type=int, default=2)
    ap.add_argument('--agree_iou', type=float, default=0.5)

    # Validators
    ap.add_argument('--validate_mesh', action='store_true')
    ap.add_argument('--min_landmarks', type=int, default=200)
    ap.add_argument('--min_mesh_conf', type=float, default=0.5)
    ap.add_argument('--min_sharpness', type=float, default=0.0)

    args = ap.parse_args()

    # Preset overrides
    if args.preset == 'precision':
        # push for high precision defaults
        if args.detector == 'haar':
            args.haar_neighbors = max(args.haar_neighbors, 9)
            args.haar_scale = max(args.haar_scale, 1.2)
        args.min_conf = max(args.min_conf, 0.75)
        args.min_face_frac = max(args.min_face_frac, 0.02)
        args.aspect_lo = max(args.aspect_lo, 0.75)
        args.aspect_hi = min(args.aspect_hi, 1.5)
        args.validate_mesh = True
        args.min_sharpness = max(args.min_sharpness, 50.0)
        args.iou_thresh = min(args.iou_thresh, 0.35)

    src = Path(args.source_folder)
    dst = Path(args.target_folder) if args.target_folder else src
    model_dir = Path(args.dnn_model_dir)
    rotations = parse_rotations(args.rotations)

    files = list(iter_images(src))
    if not files:
        print('No images found.'); return

    effective_workers = args.workers
    if args.detector in ('dnn','ensemble') and not args.force-workers if False else False:
        pass
    if args.detector == 'dnn' and not args.force_workers:
        effective_workers = 1

    total_saved = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, effective_workers)) as ex:
        futures = []
        for p in files:
            futures.append(ex.submit(
                crop_faces_from_image, p, src, dst,
                args.detector, args.min_conf, args.min_size, args.min_face_frac,
                args.aspect_lo, args.aspect_hi, args.iou_thresh, args.max_faces,
                args.margin, args.square, model_dir, rotations,
                args.haar_scale, args.haar_neighbors,
                args.agree_k, args.agree_iou,
                args.validate_mesh, args.min_landmarks, args.min_mesh_conf,
                args.min_sharpness
            ))
        for fut in tqdm(concurrent.futures.as_completed(futures), total=len(futures), desc='Cropping'):
            try:
                total_saved += fut.result()
            except Exception as e:
                sys.stderr.write(f'Error processing file: {e}\\n')

    print(f'Done. Crops saved: {total_saved}')

if __name__ == '__main__':
    main()


# 1. Fast and precise with Haar only
# Best if Haar already looks good in your set.
# python3 crop_to_face_improved.py \
#   --source_folder /source_folder/ \
#   --target_folder /target_folder/ \
#   --detector haar --preset precision \
#   --min_size 320 --min_face_frac 0.02 \
#   --haar_scale 1.25 --haar_neighbors 10 \
#   --square --margin 0.5 \
#   --validate_mesh --min_landmarks 200 --min_sharpness 60

# 2. Maximum precision via agreement of detectors
# Keeps only faces that at least 2 detectors overlap on by IoU 0.5, then validates with FaceMesh.
#
# python3 crop_to_face_improved.py \
#   --source_folder /source_folder/ \
#   -- /target_folder/ \
#   --detector ensemble --preset precision \
#   --agree_k 2 --agree_iou 0.5 \
#   --min_size 320 --min_face_frac 0.02 \
#   --square --margin 0.5 \
#   --dnn_model_dir ./.models/

# 3. Precision-tuned MediaPipe only
# If you want slightly better recall than Haar but still high precision.
#
# python3 crop_to_face_improved.py \
#   --source_folder /source_folder/ \
#   --target_folder /target_folder/ \
#   --detector mediapipe --preset precision \
#   --min_size 320 --min_face_frac 0.02 \
#   --square --margin 0.5 \
#   --validate_mesh --min_landmarks 200 --min_sharpness 60
