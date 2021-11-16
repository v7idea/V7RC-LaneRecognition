class TFliteModelImporter {
  constructor(kwargs) {
    this._isQuantized = kwargs.isQuantized;
    this._rawModel = kwargs.rawModel;
    this._model = null;
    this._compilation;
    this._execution;
    this._tensorIds = [];
    this._operands = [];
    this._operandIndex = 0;
    this._outputs;
    this._deQuantizeParams = [];
    this._requiredOps = new Set();
    this._options = {
      softmax: kwargs.softmax,
    };
    this._backend = kwargs.backend;
    this._prefer = kwargs.prefer;
    if (this._backend === 'WebML') {
      if (nnNative === null) {
        throw Error('Fails to initialize neural network context');
      }
      this._nn = nnNative;
    } else if (this._backend === 'WASM' || this._backend === 'WebGL' || this._backend === 'WebGPU') {
      this._nn = nnPolyfill;
    }
    this._bEagerMode = false;
    this._supportedOps = new Set();
  }

  setEagerMode = (flag) => {
    this._bEagerMode = flag;
  };

  setSupportedOps = (ops) => {
    this._supportedOps = ops;
  };

  async createCompiledModel() {
    let options = {
      backend: this._backend,
      eager: this._bEagerMode,
      supportedOps: this._supportedOps,
    };
    this._model = await this._nn.createModel(options);

    this._addTensorOperands();
    this._addOpsAndParams();
    this._addInputsOutputs();
    this._setDeQuantizeParams();

    await this._model.finish();
    this._compilation = await this._model.createCompilation();

    let start = performance.now();
    this._compilation.setPreference(getPreferCode(this._backend, this._prefer));
    await this._compilation.finish();
    this._execution = await this._compilation.createExecution();
    let elapsed = performance.now() - start;
    console.log(`compilation time: ${elapsed.toFixed(2)} ms`);
  }

  async compute(inputTensors, outputTensors) {
    inputTensors.forEach((inputTensor, i) => {
      this._execution.setInput(i, inputTensor);
    });
    outputTensors.forEach((outputTensor, i) => {
      this._execution.setOutput(i, outputTensor);
    });

    let error = await this._execution.startCompute();
    if (error) {
      return error;
    }
    return 'success';
  }

  _addTensorOperands() {
    let graph = this._rawModel.subgraphs(0);
    let tensorsLength = graph.tensorsLength();
    for (let i = 0; i < tensorsLength; ++i) {
      let tensor = graph.tensors(i);
      let type;
      let typedArray;
      switch (tensor.type()) {
        case tflite.TensorType.FLOAT32: {
          type = this._nn.TENSOR_FLOAT32;
          typedArray = Float32Array;
        } break;
        case tflite.TensorType.INT64: {
          type = this._nn.TENSOR_INT32;
          typedArray = Int32Array;
        } break;
        case tflite.TensorType.INT32: {
          type = this._nn.TENSOR_INT32;
          typedArray = Int32Array;
        } break;
        case tflite.TensorType.UINT8: {
          type = this._nn.TENSOR_QUANT8_ASYMM;
          typedArray = Uint8Array;
        } break;
        default: {
          throw new Error(`tensor type ${tensor.type()} is not supported.`);
        }
      }
      let dims = tensor.shapeArray().length ? Array.from(tensor.shapeArray()) : [1];
      let quantization = tensor.quantization();
      let scale = (quantization.scaleLength() === 1) ? quantization.scale(0) : 0;
      let zeroPoint = (quantization.zeroPointLength() === 1) ? quantization.zeroPoint(0).toFloat64() : 0;
      let tensorType = {type: type, dimensions: dims, scale: scale, zeroPoint: zeroPoint};
      let tensorId = this._addOperand(tensorType);
      this._tensorIds.push(tensorId);
      let buffer = this._rawModel.buffers(tensor.buffer());
      if (buffer.dataLength() > 0) {
        let raw = buffer.dataArray();
        let data = new typedArray(raw.buffer, raw.byteOffset, raw.byteLength / typedArray.BYTES_PER_ELEMENT);
        this._setOperandValue(tensorId, data);
      }
    }
  }

  _addInputsOutputs() {
    let graph = this._rawModel.subgraphs(0);
    let inputs = Array.from(graph.inputsArray());
    let outputs = Array.from(graph.outputsArray());
    let operator = graph.operators(graph.operatorsLength()-1);
    let opCode = this._rawModel.operatorCodes(operator.opcodeIndex()).builtinCode();
    if (this._options.softmax && opCode != tflite.BuiltinOperator.SOFTMAX)
      outputs = [this._operandIndex-1];
    this._outputs = outputs;
    this._model.identifyInputsAndOutputs(inputs, outputs);
  }

  _setDeQuantizeParams() {
    this._outputs.forEach(output => {
      this._deQuantizeParams.push({
        scale: this._operands[output].scale,
        zeroPoint: this._operands[output].zeroPoint
      });
    });
  }

  _getOperandValue(index) {
    return this._operands[index];
  }

  _setOperandValue(index, value) {
    this._model.setOperandValue(index, value);
    this._operands[index].value = value;
  }

  _setOperandDims(index, dims) {
    this._model._operands[index].dimensions = dims;
    this._operands[index].dimensions = dims;
  }

  _addOperand(type, value) {
    let index = this._operandIndex++;
    this._model.addOperand(type);
    this._operands[index] = {
      dimensions: type.dimensions,
      scale: type.scale,
      zeroPoint: type.zeroPoint,
      value: null
    }
    if (typeof value !== 'undefined')
      this._setOperandValue(index, value);
    return index;
  }

  _addScalarInt32(value) {
    return this._addOperand({
      type: this._nn.INT32
    }, new Int32Array([value]));
  }

  _addScalarFloat32(value) {
    return this._addOperand({
      type: this._nn.FLOAT32
    }, new Float32Array([value]));
  }

  _addTensorFloat32(tensor, dims) {
    return this._addOperand({
      type: this._nn.TENSOR_FLOAT32,
      dimensions: dims
    }, new Float32Array(tensor));
  }

  _addTensorInt32(tensor, dims) {
    return this._addOperand({
      type: this._nn.TENSOR_INT32,
      dimensions: dims
    }, new Int32Array(tensor));
  }

  _addOperation(opType, inputs, outputs) {
    this._requiredOps.add(opType);
    this._model.addOperation(opType, inputs, outputs);
  }

  async * layerIterator(inputTensors, layerList) {
    const graph = this._rawModel.subgraphs(0);
    const getLayerOutput = async (lastNode) => {
      this._tensorIds = [];
      this._operands = [];
      this._operandIndex = 0;
      if (this._backend !== 'WebML' && this._compilation) {
        this._compilation._preparedModel._deleteAll();
      }

      this._model = await this._nn.createModel({backend: this._backend});
      this._addTensorOperands();
      lastNode = this._addOpsAndParams(lastNode);

      const operator = graph.operators(lastNode);
      const inputs = Array.from(graph.inputsArray());
      const outputs = Array.from(operator.outputsArray());
      const outputName = graph.tensors(outputs[0]).name();
      this._model.identifyInputsAndOutputs(inputs, outputs);

      await this._model.finish();
      this._compilation = await this._model.createCompilation();
      this._compilation.setPreference(getPreferCode(this._backend, this._prefer));
      await this._compilation.finish();
      this._execution = await this._compilation.createExecution();

      const outputSize = graph.tensors(outputs[0]).shapeArray().reduce((a,b)=>a*b);
      let outputTensor;
      if (this._isQuantized) {
        outputTensor = new Uint8Array(outputSize);
      } else {
        outputTensor = new Float32Array(outputSize);
      }
      await this.compute(inputTensors, [outputTensor]);
      return {layerId: lastNode, outputName: outputName, tensor: outputTensor};
    }

    const operatorsLength = graph.operatorsLength();
    if (typeof layerList === 'undefined') {
      for (let lastNode = 0; lastNode < operatorsLength;) {
        const layerOutput = await getLayerOutput(lastNode);
        yield layerOutput;
        lastNode = layerOutput.layerId + 1;
      }
    } else {
      for (let layerId of layerList) {
        if (layerId >= operatorsLength || layerId < 0) {
          throw new Error(`Illegal layer ${layerId}`);
        }
        yield await getLayerOutput(layerId);
      }
    }
  }

  _addOpsAndParams(lastNode) {
    const PaddingCodeMap = new Map([
      [tflite.Padding.SAME, this._nn.PADDING_SAME],
      [tflite.Padding.VALID, this._nn.PADDING_VALID]
    ]);

    const FuseCodeMap = new Map([
      [tflite.ActivationFunctionType.NONE, this._nn.FUSED_NONE],
      [tflite.ActivationFunctionType.RELU, this._nn.FUSED_RELU],
      [tflite.ActivationFunctionType.RELU_N1_TO_1, this._nn.FUSED_RELU1],
      [tflite.ActivationFunctionType.RELU6, this._nn.FUSED_RELU6],
    ]);

    let graph = this._rawModel.subgraphs(0);
    let operatorsLength = graph.operatorsLength();
    let i;
    if (typeof lastNode === 'undefined') {
      lastNode = operatorsLength - 1;
    }
    for (i = 0; i <= lastNode; ++i) {
      let operator = graph.operators(i);
      let opCode = this._rawModel.operatorCodes(operator.opcodeIndex()).builtinCode();
      let opType;
      // some input/output tensors might be mapped to tensors
      // e.g., skipped nodes in RESIZE_BILINEAR
      let inputs = Array.from(operator.inputsArray()).map(i => this._tensorIds[i]);
      let outputs = Array.from(operator.outputsArray()).map(i => this._tensorIds[i]);
      switch (opCode) {
        case tflite.BuiltinOperator.ADD: {
          let options = operator.builtinOptions(new tflite.AddOptions());
          let fuseCode = FuseCodeMap.get(options.fusedActivationFunction());
          if (typeof fuseCode === 'undefined') {
            throw new Error(`Fuse code ${options.fusedActivationFunction()} is not supported.`);
          }
          inputs.push(this._addScalarInt32(fuseCode));
          opType = this._nn.ADD;
        } break;
        case tflite.BuiltinOperator.MUL: {
          let options = operator.builtinOptions(new tflite.MulOptions());
          let fuseCode = FuseCodeMap.get(options.fusedActivationFunction());
          if (typeof fuseCode === 'undefined') {
            throw new Error(`Fuse code ${options.fusedActivationFunction()} is not supported.`);
          }
          inputs.push(this._addScalarInt32(fuseCode));
          opType = this._nn.MUL;
        } break;
        case tflite.BuiltinOperator.SUB: {
          let options = operator.builtinOptions(new tflite.SubOptions());
          let fuseCode = FuseCodeMap.get(options.fusedActivationFunction());
          if (typeof fuseCode === 'undefined') {
            throw new Error(`Fuse code ${options.fusedActivationFunction()} is not supported.`);
          }
          inputs.push(this._addScalarInt32(fuseCode));
          opType = this._nn.SUB;
        } break;
        case tflite.BuiltinOperator.DIV: {
          let options = operator.builtinOptions(new tflite.DivOptions());
          let fuseCode = FuseCodeMap.get(options.fusedActivationFunction());
          if (typeof fuseCode === 'undefined') {
            throw new Error(`Fuse code ${options.fusedActivationFunction()} is not supported.`);
          }
          inputs.push(this._addScalarInt32(fuseCode));
          opType = this._nn.DIV;
        } break;
        
        case tflite.BuiltinOperator.CONV_2D: {
          let options = operator.builtinOptions(new tflite.Conv2DOptions());
          let paddingCode = PaddingCodeMap.get(options.padding());
          if (typeof paddingCode === 'undefined') {
            throw new Error(`Padding code ${options.padding()} is not supported.`);
          }
          inputs.push(this._addScalarInt32(paddingCode));
          if (options.dilationWFactor() !== 1 || options.dilationWFactor() !== 1) {
            inputs.push(this._addScalarInt32(options.dilationWFactor()));
            inputs.push(this._addScalarInt32(options.dilationHFactor()));
            opType = this._nn.ATROUS_CONV_2D;
          } else {
            inputs.push(this._addScalarInt32(options.strideW()));
            inputs.push(this._addScalarInt32(options.strideH()));
            opType = this._nn.CONV_2D;
          }
          let fuseCode = FuseCodeMap.get(options.fusedActivationFunction());
          if (typeof fuseCode === 'undefined') {
            throw new Error(`Fuse code ${options.fusedActivationFunction()} is not supported.`);
          }
          inputs.push(this._addScalarInt32(fuseCode));
        } break;
        case tflite.BuiltinOperator.DEPTHWISE_CONV_2D: {
          let options = operator.builtinOptions(new tflite.DepthwiseConv2DOptions());
          let paddingCode = PaddingCodeMap.get(options.padding());
          if (typeof paddingCode === 'undefined') {
            throw new Error(`Padding code ${options.padding()} is not supported.`);
          }
          inputs.push(this._addScalarInt32(paddingCode));
          if (options.dilationWFactor() !== 1 || options.dilationWFactor() !== 1) {
            inputs.push(this._addScalarInt32(options.dilationWFactor()));
            inputs.push(this._addScalarInt32(options.dilationHFactor()));
            opType = this._nn.ATROUS_DEPTHWISE_CONV_2D;
          } else {
            inputs.push(this._addScalarInt32(options.strideW()));
            inputs.push(this._addScalarInt32(options.strideH()));
            opType = this._nn.DEPTHWISE_CONV_2D;
          }
          inputs.push(this._addScalarInt32(options.depthMultiplier()));
          let fuseCode = FuseCodeMap.get(options.fusedActivationFunction());
          if (typeof fuseCode === 'undefined') {
            throw new Error(`Fuse code ${options.fusedActivationFunction()} is not supported.`);
          }
          inputs.push(this._addScalarInt32(fuseCode));
        } break;
        case tflite.BuiltinOperator.AVERAGE_POOL_2D: {
          let options = operator.builtinOptions(new tflite.Pool2DOptions());
          let paddingCode = PaddingCodeMap.get(options.padding());
          if (typeof paddingCode === 'undefined') {
            throw new Error(`Padding code ${options.padding()} is not supported.`);
          }
          inputs.push(this._addScalarInt32(paddingCode));
          inputs.push(this._addScalarInt32(options.strideW()));
          inputs.push(this._addScalarInt32(options.strideH()));
          inputs.push(this._addScalarInt32(options.filterWidth()));
          inputs.push(this._addScalarInt32(options.filterHeight()));
          let fuseCode = FuseCodeMap.get(options.fusedActivationFunction());
          if (typeof fuseCode === 'undefined') {
            throw new Error(`Fuse code ${options.fusedActivationFunction()} is not supported.`);
          }
          inputs.push(this._addScalarInt32(fuseCode));
          opType = this._nn.AVERAGE_POOL_2D;
        } break;
        case tflite.BuiltinOperator.MAX_POOL_2D: {
          let options = operator.builtinOptions(new tflite.Pool2DOptions());
          let paddingCode = PaddingCodeMap.get(options.padding());
          if (typeof paddingCode === 'undefined') {
            throw new Error(`Padding code ${options.padding()} is not supported.`);
          }
          inputs.push(this._addScalarInt32(paddingCode));
          inputs.push(this._addScalarInt32(options.strideW()));
          inputs.push(this._addScalarInt32(options.strideH()));
          inputs.push(this._addScalarInt32(options.filterWidth()));
          inputs.push(this._addScalarInt32(options.filterHeight()));
          let fuseCode = FuseCodeMap.get(options.fusedActivationFunction());
          if (typeof fuseCode === 'undefined') {
            throw new Error(`Fuse code ${options.fusedActivationFunction()} is not supported.`);
          }
          inputs.push(this._addScalarInt32(fuseCode));
          opType = this._nn.MAX_POOL_2D;
        } break;
        case tflite.BuiltinOperator.SOFTMAX: {
          let options = operator.builtinOptions(new tflite.SoftmaxOptions());
          inputs.push(this._addScalarFloat32(options.beta()));
          opType = this._nn.SOFTMAX;
        } break;
        case tflite.BuiltinOperator.CONCATENATION: {
          let options = operator.builtinOptions(new tflite.ConcatenationOptions());
          inputs.push(this._addScalarInt32(options.axis()));
          opType = this._nn.CONCATENATION;
        } break;
        case tflite.BuiltinOperator.RESHAPE: {
          let options = operator.builtinOptions(new tflite.ReshapeOptions());
          // targetShape is in tensor
          opType = this._nn.RESHAPE;
        } break;
        case tflite.BuiltinOperator.SQUEEZE: {
          let options = operator.builtinOptions(new tflite.SqueezeOptions());
          let tensorType = {type: this._nn.TENSOR_INT32, dimensions: [2]};
          let tensorId = this._operandIndex++;
          this._model.addOperand(tensorType);
          this._tensorIds.push(tensorId);
          this._model.setOperandValue(tensorId, new Int32Array([1, 1001]));
          inputs.push(tensorId);
          opType = this._nn.RESHAPE;
        } break;
        case tflite.BuiltinOperator.FULLY_CONNECTED: {
          let options = operator.builtinOptions(new tflite.FullyConnectedOptions());
          let fuseCode = FuseCodeMap.get(options.fusedActivationFunction());
          if (typeof fuseCode === 'undefined') {
            throw new Error(`Fuse code ${options.fusedActivationFunction()} is not supported.`);
          }
          inputs.push(this._addScalarInt32(fuseCode));
          opType = this._nn.FULLY_CONNECTED;
        } break;
        case tflite.BuiltinOperator.RESIZE_BILINEAR: {
          let options = operator.builtinOptions(new tflite.ResizeBilinearOptions());
          let newSize = this._operands[inputs[1]].value;
          inputs = [inputs[0]];
          inputs.push(this._addScalarInt32(newSize[0]));
          inputs.push(this._addScalarInt32(newSize[1]));
          inputs.push(this._addScalarInt32(options.alignCorners() ? 1 : 0));
          opType = this._nn.RESIZE_BILINEAR;
        } break;
        case tflite.BuiltinOperator.MIRROR_PAD: {
          let options = operator.builtinOptions(new tflite.MirrorPadOptions());
          let mode = options.mode();
          inputs.splice(1, 0, this._addScalarInt32(mode));
          opType = this._nn.PAD;
        } break;
        case tflite.BuiltinOperator.MEAN: {
          inputs.push(this._addScalarInt32(1));  //How to get keepDims value?
          opType = this._nn.MEAN;
        } break;
        case tflite.BuiltinOperator.SQUARED_DIFFERENCE: {
          opType = this._nn.SQUARED_DIFFERENCE;
        } break;
        case tflite.BuiltinOperator.TRANSPOSE_CONV: {
          let options = operator.builtinOptions(new tflite.TransposeConvOptions());
          let weightsId = inputs[1];
          let weights = this._getOperandValue(weightsId);
          let weightsValue = weights.value;
          let weightsDims = weights.dimensions;
          let weightsArray = new Float32Array(weightsValue.length);
          const O = weightsDims[0];
          const H = weightsDims[1];
          const W = weightsDims[2];
          const I = weightsDims[3];
          for (let o = 0; o < O; ++o) {
            for (let h = 0; h < H; ++h) {
              for (let w = 0; w < W; ++w) {
                for (let i = 0; i < I; ++i) {
                  weightsArray[h*W*O*I + w*O*I + o*I + i] = weightsValue[o*H*W*I + h*W*I + w*I + i];
                }
              }
            }
          }
          weightsDims.splice(2, 0, weightsDims.shift());
          this._setOperandValue(weightsId, weightsArray);
          this._setOperandDims(weightsId, weightsDims);

          inputs = [inputs[2], inputs[1], inputs[0]];
          let stride_h = options.strideH();
          let stride_w = options.strideW();
          let strides = [stride_h, stride_w];
          inputs.push(this._addTensorInt32(strides, [strides.length]));
          opType = this._nn.TRANSPOSE_CONV_2D;
        } break;
        case tflite.BuiltinOperator.POW: {
          opType = this._nn.POW;
        } break;
        case tflite.BuiltinOperator.TANH: {
          opType = this._nn.TANH;
        } break;
        case tflite.BuiltinOperator.BATCH_TO_SPACE_ND: {
          inputs = [inputs[0], inputs[1]];
          opType = this._nn.BATCH_TO_SPACE_ND;
        } break;
        case tflite.BuiltinOperator.TRANSPOSE: {
          opType = this._nn.TRANSPOSE;
        } break;
        case tflite.BuiltinOperator.MAXIMUM: {
          opType = this._nn.MAXIMUM;
        } break;
        case tflite.BuiltinOperator.ARG_MAX: {
          let axis = this._operands[inputs[1]].value[0];
          let operandId = this._addScalarInt32(axis);
          inputs[1] = operandId;
          if (this._nn.ARGMAX === undefined) {
            let currentPreferText = {
              fast: 'FAST_SINGLE_ANSWER',
              sustained: 'SUSTAINED_SPEED',
              low: 'LOW_POWER',
            }[this._prefer];
            throw new Error(`Operator type 'ARGMAX' is not supported by WebNN\(${currentPreferText}\), please use dual backend for test.`);
          } else {
            opType = this._nn.ARGMAX;
          }
        } break;
        default: {
          throw new Error(`operator type ${opCode} is not supported.`);
        }
      }

      if (i === operatorsLength - 1) {
        if (this._options.softmax && opCode != tflite.BuiltinOperator.SOFTMAX) {
          this._addOperation(opType, inputs, outputs);
          let outputTensor = graph.tensors(outputs[0]);
          // Add inputs
          inputs = [];
          inputs.push(outputs[0]);
          // Set beta to 1.0
          inputs.push(this._addScalarFloat32(1.0));
          // Add outputs
          outputs = [];
          let tensorType;
          if (graph.tensors(inputs[0]).type() === tflite.TensorType.UINT8) {
            tensorType = {type: this._nn.TENSOR_QUANT8_ASYMM, dimensions: Array.from(outputTensor.shapeArray()), scale: 1 / 256, zeroPoint: 0};
          } else {
            tensorType = {type: this._nn.TENSOR_FLOAT32, dimensions: Array.from(outputTensor.shapeArray()), scale: 0, zeroPoint: 0};
          }
          let tensorId = this._addOperand(tensorType);
          this._tensorIds.push(tensorId);
          outputs.push(tensorId);

          opType = this._nn.SOFTMAX;
        }
      }

      this._addOperation(opType, inputs, outputs);
    }
    return i - 1;
  }

  getRequiredOps() {
    return this._requiredOps;
  }
}