"""Regression checks for false-positive filtering, rotations, and CUDA decoding."""
from pathlib import Path
import contextlib
import io
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import crop_to_face_improved as crop
import face_detection_yunet as yunet


class FaceCroppingTests(unittest.TestCase):
    def test_existing_output_subtree_is_excluded_but_parent_output_is_allowed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source'
            target = source / 'faces'
            target.mkdir(parents=True)
            cv2.imwrite(str(source / 'original.png'), np.zeros((10, 10, 3), np.uint8))
            cv2.imwrite(str(target / 'existing_face.png'), np.zeros((10, 10, 3), np.uint8))
            for destination, expected_count in [(target, 1), (root, 2)]:
                argv = ['crop_to_face_improved.py', '--source_folder', str(source),
                        '--target_folder', str(destination), '--device', 'cpu', '--no-validate_mesh']
                with self.subTest(destination=destination), \
                        mock.patch.object(sys, 'argv', argv), \
                        mock.patch.object(crop, 'YuNetDetector', return_value=SimpleNamespace(backend='CPU')), \
                        mock.patch.object(crop, 'crop_faces_from_image', return_value=0) as process, \
                        contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(crop.main(), 0)
                    self.assertEqual(process.call_count, expected_count)

    def test_defaults_use_strict_neural_detection_and_validation(self):
        args = crop.build_parser().parse_args(['--source_folder', '/example'])
        self.assertEqual(args.detector, 'auto')
        self.assertEqual(args.min_conf, 0.9)
        self.assertTrue(args.validate_mesh)
        args = crop.build_parser().parse_args(['--source_folder', '/example', '--no-validate_mesh'])
        self.assertFalse(args.validate_mesh)

    def test_auto_does_not_accept_haar_only_false_positives(self):
        image = np.zeros((512, 512, 3), np.uint8)
        with mock.patch.object(crop, 'detect_faces_yunet', return_value=[]), \
                mock.patch.object(crop, 'detect_faces_haar') as haar, \
                mock.patch.object(crop, 'detect_faces_dnn') as dnn, \
                mock.patch.object(crop, 'detect_faces_mediapipe') as mediapipe:
            self.assertEqual(crop.detect_faces_single(image, 'auto', .9, 256,
                             Path('.models'), [0, 90, 270], 1.2, 8), [])
        haar.assert_not_called()
        dnn.assert_not_called()
        mediapipe.assert_not_called()

    def test_rotation_maps_back_and_retains_detection_orientation(self):
        # Original box: x=30, y=50, w=80, h=120 in a 400x300 image.
        boxes = {0: (30, 50, 80, 120), 90: (130, 30, 120, 80),
                 180: (290, 130, 80, 120), 270: (50, 290, 120, 80)}
        for rotation, values in boxes.items():
            with self.subTest(rotation=rotation):
                face = crop.map_box_back(crop.Face(*values, .95), rotation, 400, 300)
                self.assertEqual((face.x, face.y, face.w, face.h), (30, 50, 80, 120))
                self.assertEqual(face.rotation, rotation)

    def test_missing_mediapipe_cannot_silently_pass_verification(self):
        with mock.patch.object(crop, '_HAS_MEDIAPIPE', False):
            with self.assertRaisesRegex(RuntimeError, 'MediaPipe'):
                crop.validate_with_facemesh(np.zeros((100, 100, 3), np.uint8))

    def test_mesh_rejects_neighboring_face_in_verification_crop(self):
        landmarks = [SimpleNamespace(x=.75 + i / 1000, y=.75 + i / 1000)
                     for i in range(20)]
        result = SimpleNamespace(multi_face_landmarks=[SimpleNamespace(landmark=landmarks)])
        with mock.patch.object(crop, '_get_mediapipe', return_value=SimpleNamespace(
                process=lambda image: result)):
            self.assertFalse(crop.validate_with_facemesh(np.zeros((100, 100, 3), np.uint8),
                             min_landmarks=20, expected_box=(10, 10, 30, 30)))

    def test_mesh_accepts_matching_face_and_bounds_processing_resolution(self):
        landmarks = [SimpleNamespace(x=.3, y=.3), SimpleNamespace(x=.7, y=.7)]
        result = SimpleNamespace(multi_face_landmarks=[SimpleNamespace(landmark=landmarks)])
        process = mock.Mock(return_value=result)
        with mock.patch.object(crop, '_get_mediapipe', return_value=SimpleNamespace(process=process)):
            self.assertTrue(crop.validate_with_facemesh(np.zeros((1600, 1600, 3), np.uint8),
                            min_landmarks=2, expected_box=(320, 320, 960, 960)))
        self.assertEqual(process.call_args.args[0].shape, (512, 512, 3))

    def test_mediapipe_model_is_reused_per_worker_and_configuration(self):
        local = SimpleNamespace()
        factory = mock.Mock()
        mp = SimpleNamespace(solutions=SimpleNamespace(face_mesh=SimpleNamespace(FaceMesh=factory)))
        with mock.patch.object(crop, '_LOCAL', local), mock.patch.object(crop, 'mp', mp), \
                mock.patch.object(crop, '_HAS_MEDIAPIPE', True), \
                mock.patch.object(crop, '_MP_MODELS', []):
            self.assertIs(crop._get_mediapipe('mesh', .7), crop._get_mediapipe('mesh', .7))
            factory.assert_called_once()
            crop._get_mediapipe('mesh', .8)
            self.assertEqual(factory.call_count, 2)

    def test_rejected_candidate_does_not_use_max_faces_quota(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image_path = root / 'source.png'
            cv2.imwrite(str(image_path), np.full((300, 600, 3), 100, np.uint8))
            candidates = [crop.Face(10, 10, 100, 100, .99),
                          crop.Face(300, 10, 100, 100, .95)]
            with mock.patch.object(crop, 'detect_faces_single', return_value=candidates), \
                    mock.patch.object(crop, 'validate_with_facemesh', side_effect=[False, True]) as verifier:
                count = crop.crop_faces_from_image(
                    image_path, root, root / 'out', 'auto', .9, 50, .01, .6, 1.8,
                    .4, 1, .6, False, Path('.models'), [0], 1.2, 8, 2, .5,
                    True, 200, .7, 0)
            self.assertEqual(count, 1)
            self.assertEqual(verifier.call_count, 2)
            self.assertTrue((root / 'out' / 'source_face_1.png').exists())

    def test_validation_crop_is_upright_for_quarter_turn_detections(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'source.png'
            cv2.imwrite(str(path), np.zeros((300, 600, 3), np.uint8))
            for rotation in (0, 90, 180, 270):
                with self.subTest(rotation=rotation), \
                        mock.patch.object(crop, 'detect_faces_single', return_value=[
                            crop.Face(200, 60, 80, 120, .95, 'yunet', rotation)]), \
                        mock.patch.object(crop, 'validate_with_facemesh', return_value=True) as verifier:
                    crop.crop_faces_from_image(
                        path, root, root / 'out', 'auto', .9, 50, .01, .6, 1.8,
                        .4, 1, .6, False, Path('.models'), [0], 1.2, 8, 2, .5,
                        True, 200, .7, 0)
                    image = verifier.call_args.args[0]
                    box = verifier.call_args.kwargs['expected_box']
                    height, width = image.shape[:2]
                    self.assertEqual((width, height), (96, 144) if rotation in (0, 180) else (144, 96))
                    self.assertEqual(box[2:], (80, 120) if rotation in (0, 180) else (120, 80))
                    self.assertAlmostEqual(box[0] + box[2] / 2, width / 2)
                    self.assertAlmostEqual(box[1] + box[3] / 2, height / 2)

    def test_failed_image_write_reports_error(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'source.png'
            cv2.imwrite(str(path), np.zeros((100, 100, 3), np.uint8))
            with mock.patch.object(crop, 'detect_faces_single', return_value=[crop.Face(10, 10, 80, 80, .95)]), \
                    mock.patch.object(cv2, 'imwrite', return_value=False):
                with self.assertRaisesRegex(OSError, 'Could not save'):
                    crop.crop_faces_from_image(
                        path, root, root / 'out', 'auto', .9, 10, .01, .6, 1.8,
                        .4, 1, .6, False, Path('.models'), [0], 1.2, 8, 2, .5,
                        False, 200, .7, 0)

    def test_yunet_clips_at_image_edges_and_ignores_padding(self):
        rows = np.zeros((3, 15), np.float32)
        rows[:, :4] = [(-10, -10, 80, 80), (90, 10, 80, 80), (110, 10, 20, 20)]
        rows[:, 14] = .95
        with mock.patch.object(crop, '_YUNET', SimpleNamespace(detect=lambda image: rows)):
            faces = crop.detect_faces_yunet(np.zeros((100, 100, 3), np.uint8))
        self.assertEqual([(f.x, f.y, f.w, f.h) for f in faces], [(0, 0, 70, 70), (90, 10, 10, 80)])

    def test_cuda_decoder_uses_all_scales_and_suppresses_duplicate_boxes(self):
        # One detection centered at (32, 32), size 32x32, on all scales.
        outputs = {}
        for stride in (8, 16, 32):
            count = (64 // stride) ** 2
            for name, channels in [('cls', 1), ('obj', 1), ('bbox', 4), ('kps', 10)]:
                outputs[f'{name}_{stride}'] = np.zeros((1, count, channels), np.float32)
            column = row = 32 // stride
            index = row * (64 // stride) + column
            outputs[f'cls_{stride}'][0, index, 0] = 1
            outputs[f'obj_{stride}'][0, index, 0] = .96 ** 2
            outputs[f'bbox_{stride}'][0, index, 2:] = np.log(32 / stride)
        faces = yunet.decode_outputs(outputs, 64, .9, .4)
        self.assertEqual(faces.shape, (1, 15))
        np.testing.assert_allclose(faces[0, :4], [16, 16, 32, 32], atol=1e-5)
        np.testing.assert_allclose(faces[0, 4:14].reshape(5, 2), [[32, 32]] * 5)
        self.assertAlmostEqual(faces[0, 14], .96, places=5)

    def test_cuda_decoder_empty_predictions(self):
        outputs = {}
        for stride in (8, 16, 32):
            count = (64 // stride) ** 2
            outputs[f'cls_{stride}'] = outputs[f'obj_{stride}'] = np.zeros((1, count, 1), np.float32)
        self.assertEqual(yunet.decode_outputs(outputs, 64, .9, .4).shape, (0, 15))

    def test_missing_custom_model_does_not_download_something_else(self):
        with mock.patch.object(yunet.urllib.request, 'urlopen') as download:
            with self.assertRaises(FileNotFoundError):
                yunet.ensure_model(Path('/tmp/nonexistent-custom-yunet.onnx'))
        download.assert_not_called()


if __name__ == '__main__':
    unittest.main()
