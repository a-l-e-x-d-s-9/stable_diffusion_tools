
#!/usr/bin/env python3
import argparse, itertools, math
from typing import List, Tuple
import numpy as np
from PIL import Image

def parse_palette(palette_str: str) -> List[Tuple[int,int,int]]:
    def hex_to_rgb(h: str) -> Tuple[int,int,int]:
        h = h.strip()
        if h.startswith('#'):
            h = h[1:]
        if len(h) == 3:
            h = ''.join([c*2 for c in h])
        if len(h) != 6:
            raise ValueError(f'Bad hex color: {h}')
        return tuple(int(h[i:i+2], 16) for i in (0,2,4))
    return [hex_to_rgb(s) for s in palette_str.split(',') if s.strip()]

def get_dominant_colors(im: Image.Image, k: int):
    q = im.convert('RGB').quantize(colors=k, method=Image.Quantize.MEDIANCUT)
    pal = q.getpalette()[:k*3]
    counts = sorted(q.getcolors(), key=lambda x: x[0], reverse=True)
    def idx_to_rgb(idx):
        i = idx*3
        return tuple(pal[i:i+3])
    colors = [idx_to_rgb(idx) for _, idx in counts]
    return colors

def best_assignment(src, tgt):
    m = min(len(src), len(tgt))
    src = src[:m]
    best_perm, best_cost = None, float('inf')
    for perm in itertools.permutations(range(len(tgt)), m):
        cost = 0.0
        for i, j in enumerate(perm):
            a = np.array(src[i], dtype=float)
            b = np.array(tgt[j], dtype=float)
            cost += np.linalg.norm(a - b)
        if cost < best_cost:
            best_cost, best_perm = cost, perm
    tgt_matched = [tgt[j] for j in best_perm]
    return src, tgt_matched

def solve_affine(src: np.ndarray, tgt: np.ndarray, l2: float=1e-2) -> np.ndarray:
    X = np.hstack([src, np.ones((src.shape[0],1))])
    Y = tgt
    reg = math.sqrt(l2)
    X_reg = np.vstack([X, reg*np.eye(4)])
    Y_reg = np.vstack([Y, np.zeros((4,3))])
    M, *_ = np.linalg.lstsq(X_reg, Y_reg, rcond=None)
    return M.T  # 3x4

def apply_transform(img: np.ndarray, M: np.ndarray, strength: float, preserve_neutral: bool=True) -> np.ndarray:
    h, w, _ = img.shape
    flat = img.reshape(-1, 3).astype(np.float32)
    X = np.hstack([flat, np.ones((flat.shape[0],1), dtype=np.float32)])
    out = X @ M.T
    if preserve_neutral:
        luma = (0.2126*flat[:,0] + 0.7152*flat[:,1] + 0.0722*flat[:,2]) / 255.0
        mask = np.clip((luma-0.05)/(0.95-0.05), 0.0, 1.0)
        alpha = (strength * mask)[:, None]
    else:
        alpha = strength
    blended = flat*(1-alpha) + out*alpha
    blended = np.clip(blended, 0, 255).reshape(h, w, 3).astype(np.uint8)
    return blended

def main():
    ap = argparse.ArgumentParser(description='Recolor image toward a target palette via global affine transform')
    ap.add_argument('--input', required=True)
    ap.add_argument('--output', required=True)
    ap.add_argument('--palette', required=True, help='Comma-separated hex colors')
    ap.add_argument('--k', type=int, default=8)
    ap.add_argument('--strength', type=float, default=0.8)
    ap.add_argument('--l2', type=float, default=1e-2)
    ap.add_argument('--preserve-neutral', action='store_true', default=True)
    ap.add_argument('--no-preserve-neutral', dest='preserve_neutral', action='store_false')
    args = ap.parse_args()

    im = Image.open(args.input).convert('RGB')
    src_colors = get_dominant_colors(im, args.k)
    tgt_colors = parse_palette(args.palette)
    if len(tgt_colors) == 0:
        raise ValueError('Empty target palette')
    src_match, tgt_match = best_assignment(src_colors, tgt_colors)
    src = np.array(src_match, dtype=np.float32)
    tgt = np.array(tgt_match, dtype=np.float32)
    M = solve_affine(src, tgt, l2=args.l2)
    img_np = np.array(im, dtype=np.uint8)
    recolored = apply_transform(img_np, M, strength=args.strength, preserve_neutral=args.preserve_neutral)
    Image.fromarray(recolored, mode='RGB').save(args.output)
    side = Image.new('RGB', (im.width*2, im.height))
    side.paste(im, (0,0))
    side.paste(Image.fromarray(recolored), (im.width, 0))
    preview_path = args.output.rsplit('.', 1)[0] + '_side_by_side.png'
    side.save(preview_path)
    print(f'Wrote {args.output} and preview {preview_path}')
    print('Matched pairs:')
    for s, t in zip(src_match, tgt_match):
        print(f'  #{s[0]:02x}{s[1]:02x}{s[2]:02x} -> #{t[0]:02x}{t[1]:02x}{t[2]:02x}')

if __name__ == '__main__':
    main()
