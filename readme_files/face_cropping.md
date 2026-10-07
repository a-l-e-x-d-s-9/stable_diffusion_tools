# Face extraction

Run with the same folder arguments as before:

```bash
venv/bin/python crop_to_face_improved.py \
  --source_folder /path/to/images \
  --target_folder /path/to/faces
```

The default `auto` detector now uses **YuNet**, with a confidence threshold of
**0.9**, followed by **FaceMesh verification** at confidence **0.7**. Previously,
`auto` saved the union of MediaPipe, SSD, and Haar detections, including Haar-only
false positives, without verification. Missing SSD model files also meant the
SSD detector contributed nothing. Legacy detectors remain selectable explicitly.
The old 90°/270° coordinate mapping was also reversed, so a valid rotated face
detection could save a crop from the wrong part of the original image. This is
fixed for every detector.

Verification runs on a tight crop rather than the output crop's wider margin.
It checks that FaceMesh found the candidate face, restores its upright detection
orientation, and rejects candidates for which no matching face mesh is found.
MediaPipe always returns 468 landmarks for a successful mesh, so increasing
`--min_landmarks` below 468 does not make detection stricter. Use confidence
thresholds instead. Models are cached per worker rather than rebuilt per image
or crop. `--max_faces` counts accepted crops after verification.

YuNet runs on a letterboxed 640×640 image; minimum face size is still checked in
original image pixels. The defaults still search 0°, 90°, and 270°, preserve the
output margin of 0.6, and require a face at least 256 pixels wide and tall.
FaceMesh inputs are limited to 512 pixels on the longest side. Four workers
overlap image loading, CPU verification, and writing around a shared GPU session.
The target subtree is excluded when it is inside the source folder.

## GPU setup

`--device auto` tries ONNX Runtime CUDA, then reports a fallback to OpenCV CPU if
CUDA is unavailable. The startup message shows the backend actually selected.
FaceMesh verification runs on CPU; YuNet inference runs on GPU when CUDA is
selected. Stock pip OpenCV wheels do not need CUDA support for this path.

For the current RTX 3060 Laptop environment with PyTorch 2.5, CUDA 12.4, and
cuDNN 9, use ONNX Runtime GPU **1.20.0**. This version can reuse the existing
PyTorch CUDA libraries and avoids newer builds requiring a newer CUDA runtime.
Do not install the CPU and GPU ONNX Runtime distributions together:

```bash
venv/bin/python -m pip uninstall -y onnxruntime onnxruntime-gpu
venv/bin/python -m pip install -r requirements-face-crop-gpu.txt
```

These instructions assume CUDA-enabled PyTorch is already installed, as it is in
this workspace. For other environments, match ONNX Runtime to the installed
CUDA/cuDNN versions using the [official compatibility table](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html).
A CPU-only setup needs just `requirements-face-crop.txt` and `--device cpu`.
MediaPipe is pinned to a version exposing the legacy `solutions.face_mesh` API.
If verification is requested but this API is missing, the script fails before
saving crops instead of silently bypassing verification.

To require the GPU and fail if it cannot initialize, add `--device cuda`.

## Precision and speed controls

- **Fewer false positives:** add `--preset precision`. This raises detector
  confidence to at least 0.95 and mesh confidence to at least 0.8, requires more
  image area and a narrower aspect range, and rejects blurry crops using the
  existing sharpness filter. It can discard obscured, profile, stylized, or blurry
  real faces. It always enables mesh verification.
- **Faster for upright images:** add `--rotations 0` to run one detection pass
  rather than three.
- **Recover difficult real faces:** lower `--min_conf` or `--min_mesh_conf`.
  `--no-validate_mesh` disables the second check in the balanced preset, with
  an increased risk of false positives.
- **Smaller faces:** lower `--min_size` and, if needed, `--min_face_frac`.
  Very small faces in very large images can be lost at the 640×640 detector
  resolution; this pipeline is tuned for the existing 256-pixel crop minimum.

No detector guarantees zero false positives. Compare on representative images,
including profiles and your art styles, before running a large dataset. Existing
crops in the target directory are not removed when a new run rejects them; use
a fresh target directory to assess the changed defaults.

## Model

The script automatically downloads the 227 KB
[official OpenCV Zoo YuNet 2023 model](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet)
into `.models/`, checks its SHA-256, and reuses it on later runs. The model is
MIT-licensed; see [the bundled license](yunet_LICENSE.txt). To run offline, place
the model there first or pass `--yunet_model /path/to/face_detection_yunet_2023mar.onnx`.
The ONNX Runtime path expects this model's fixed 640×640 input and named outputs.
Legacy `--detector dnn` / `ensemble` still require the Caffe model files under
`--dnn_model_dir`.

Run regression checks without downloading a model or requiring a GPU:

```bash
venv/bin/python -m unittest discover -s tests -p test_face_cropping.py -v
```

## Local verification

On the RTX 3060 Laptop, a small smoke test retained both the upright and sideways
large human-face fixtures and saved no crops from fruit, a baboon, a blank image,
or deterministic random noise. The original defaults saved a noise crop in this
test. The unscaled 512×512 face fixture was excluded by the existing 256-pixel
minimum in both pipelines. CPU and GPU produced the same accepted crop filenames.

Processing these seven fixtures six times, with four workers in both pipelines,
measured 12.1 images/second for the old defaults and 67.8 for the new GPU defaults.
The old SSD detector was unavailable, matching the workspace's missing Caffe
files. The timing excludes imports and GPU initialization, uses warm filesystem
caches, and includes crop verification and writing. This is a small synthetic
comparison, not a throughput or accuracy estimate for a real dataset.
