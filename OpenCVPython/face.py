import datetime
import time
import cv2 as cv
# Load the model.
net = cv.dnn.readNet('face-detection-retail-0005.xml',
                     'face-detection-retail-0005.bin')
# Specify target device
net.setPreferableTarget(cv.dnn.DNN_TARGET_CPU)
# Read an image - used an extracted image the open source video: face-detection for this example
frame = cv.imread('face-1.jpg')
if frame is None:
    raise Exception('Image not found!')
# Prepare input blob and perform an inference.
blob = cv.dnn.blobFromImage(frame, size=(672, 384), ddepth=cv.CV_8U)
net.setInput(blob)
out = net.forward()
# Draw detected faces on the frame.
for detection in out.reshape(-1, 7):
    confidence = float(detection[2])
    xmin = int(detection[3] * frame.shape[1])
    ymin = int(detection[4] * frame.shape[0])
    xmax = int(detection[5] * frame.shape[1])
    ymax = int(detection[6] * frame.shape[0])
    if confidence > 0.5:
        cv.rectangle(frame, (xmin, ymin), (xmax, ymax), color=(0, 255, 0))
# Save the frame to an image file:
# Create a date_string variable with the format
date_string = time.strftime("%Y-%m-%d-%H:%M:%S")
# create imageName variable that takes adds the date_string to the output file name
imageName = 'test' + date_string +'.png'
# output with name and frame
cv.imwrite( imageName, frame );
