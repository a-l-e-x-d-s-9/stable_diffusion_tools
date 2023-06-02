import cupy as cp
import cv2
import matplotlib.pyplot as plt

# Load image with OpenCV
image = cv2.imread('path_to_your_image')

# Convert image to CuPy array
image_gpu = cp.asarray(image)

# Compute histogram on the GPU
hist_gpu = cp.histogram(image_gpu, bins=256, range=(0,256))

# Convert histogram back to NumPy array (if you want to plot it with matplotlib)
hist_cpu = cp.asnumpy(hist_gpu)

# Plot histogram
plt.figure()
plt.title("Color Histogram")
plt.xlabel("Bins")
plt.ylabel("# of Pixels")
plt.plot(hist_cpu)
plt.xlim([0, 256])
plt.show()
