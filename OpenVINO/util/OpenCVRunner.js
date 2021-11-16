class OpenCVRunner extends BaseRunner {
  constructor() {
    super();
    this._output = null;
  }

  /** @override */
  _loadModelFile = async (url) => {
    if (url !== undefined) {
      const arrayBuffer = await this._loadURL(url, this._progressHandler, true);
      const bytes = new Uint8Array(arrayBuffer);
      const modelName = this._currentModelInfo.modelFile.split('/').pop();
      switch (url.split('.').pop()) {
        case 'onnx':
          const err = onnx.ModelProto.verify(bytes);
          if (err) {
            throw new Error(`The model file ${url} is invalid, ${err}`);
          }
          try {
            cv.FS_createDataFile('/', modelName, bytes, true, false, false);
          } catch (e) {
            if (e.errno === 17) {
              console.log(`${modelName} already exited.`);
            } else {
              console.error(e);
            }
          }
          break;
        case 'pb':
          try {
            cv.FS_createDataFile('/', modelName, bytes, true, false, false);
          } catch (e) {
            if (e.errno === 17) {
              console.log(`${modelName} already exited.`);
            } else {
              console.error(e);
            }
          }
          break;
        default:
          throw new Error(`Unrecognized model format, support TFLite | ONNX | OpenVINO model`);
      }
    } else {
      throw new Error(`There's none model file info, please check config info of modelZoo.`);
    }

    this._setLoadedFlag(true);
  };

  /** @override */
  doInitialization = (modelInfo) => {
    this._setLoadedFlag(false);
    this._setInitializedFlag(false);
    this._setModelInfo(modelInfo);
  };

  /** @override */
  _doCompile = (options) => {
    let model = null;

    const modelFormat = this._currentModelInfo.format;
    if (modelFormat === 'ONNX' || modelFormat === 'Tensorflow') {
      model = cv.readNet(this._currentModelInfo.modelFile.split('/').pop());
      this._setModel(model);
    } else {
      throw new Error(`Unsupported '${this._currentModelInfo.format}' input`);
    }
  };

  /** @override */
  _getInputTensor = (input) => {
    const src = input.src;
    const options = input.options;
    const mean = options.preOptions.mean;
    const std = options.preOptions.std;
    const [sizeW, sizeH, channels] = options.inputSize;

    const imageChannels = options.imageChannels;
    src.width = src.videoWidth || src.naturalWidth || 1;
    src.height = src.videoHeight || src.naturalHeight || 1;

    const canvasElement = document.createElement('canvas');
    canvasElement.width = sizeW;
    canvasElement.height = sizeH;
    const canvasContext = canvasElement.getContext('2d');

    if (options.scaledFlag) {
      const resizeRatio = Math.max(Math.max(src.width, src.height) / sizeW, 1);
      const scaledWidth = Math.floor(src.width / resizeRatio);
      const scaledHeight = Math.floor(src.height / resizeRatio);
      canvasContext.drawImage(src, 0, 0, scaledWidth, scaledHeight);
    } else {
      canvasContext.drawImage(src, 0, 0, sizeW, sizeH);
    }

    const pixels = canvasContext.getImageData(0, 0, sizeW, sizeH).data;
    let stddata = [];
    for (let c = 0; c < channels; ++c) {
      for (let h = 0; h < sizeH; ++h) {
        for (let w = 0; w < sizeW; ++w) {
          let value = pixels[h * sizeW * imageChannels + w * imageChannels + c];
          stddata[h * sizeW * channels + w * channels + c] = (value / 255 - mean[c]) / std[c];
        }
      }
    }
    let inputMat = cv.matFromArray(sizeH, sizeW, cv.CV_32FC3, stddata);
    let tensor = cv.blobFromImage(inputMat, 1, new cv.Size(sizeW, sizeH), new cv.Scalar(0, 0, 0));
    inputMat.delete();
    this._model.setInput(tensor);
    tensor.delete();
  };

  /** @override */
  _doInference = () => {
    this._output = this._model.forward();
  };
}
