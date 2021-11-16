class OnnxModelImporter {
  constructor(kwargs) {
    this._isQuantized = kwargs.isQuantized;
    this._rawModel = kwargs.rawModel;
    this._model = null;
    this._compilation;
    this._execution;
    this._tensorIds = [];
    this._tensorTypes = [];
    this._operations = [];
    this._operands = [];
    this._requiredOps = new Set();
    this._options = {
      softmax: kwargs.softmax,
    };
    this._operandIndex = 0;
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

  getModelParams() {
    return {
      tensorTypes: this._tensorTypes,
      operations: this._operations,
      tensorIds: this._tensorIds,
      operands: this._operands
    };
  }

  async * layerIterator(inputTensors, layerList) {
    const graph = this._rawModel.graph;
    const getLayerOutput = async (lastNode) => {
      this._tensorIds = [];
      this._tensorTypes = [];
      this._operations = [];
      this._operands = [];
      this._operandIndex = 0;
      if (this._backend !== 'WebML' && this._compilation) {
        this._compilation._preparedModel._deleteAll();
      }

      this._model = await this._nn.createModel({backend: this._backend});
      this._addTensorOperands();
      lastNode = this._addOpsAndParams(lastNode);

      const outputName = graph.node[lastNode].output[0];
      const inputs = [this._getTensorIdByName(graph.node[0].input[0])];
      const outputs = [this._getTensorIdByName(outputName)];
      this._model.identifyInputsAndOutputs(inputs, outputs);

      await this._model.finish();
      this._compilation = await this._model.createCompilation();
      this._compilation.setPreference(getPreferCode(this._backend, this._prefer));
      await this._compilation.finish();
      this._execution = await this._compilation.createExecution();

      const outputSize = this._getTensorTypeByName(outputName).dimensions.reduce((a, b) => a * b);
      let outputTensor;
      if (this._isQuantized) {
        outputTensor = new Uint8Array(outputSize);
      } else {
        outputTensor = new Float32Array(outputSize);
      }
      await this.compute(inputTensors, [outputTensor]);
      return {layerId: lastNode, outputName: outputName, tensor: outputTensor, outputIds: outputs, inputIds: inputs};
    }

    const operatorsLength = graph.node.length;
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

  _getOperandValue(id) {
    return this._operands[id];
  }

  _getOperandValueByName(name) {
    return this._getOperandValue(this._getTensorIdByName(name));
  }

  _getInputByName(name) {
    return getObjectByName(this._rawModel.graph.input, name);
  }

  _getOutputByName(name) {
    return getObjectByName(this._rawModel.graph.output, name);
  }

  _getInitializerByName(name) {
    return getObjectByName(this._rawModel.graph.initializer, name);
  }

  _addTensorOperands() {
    const graph = this._rawModel.graph;

    for (let i = 0; i < graph.input.length; ++i) {
      this._addTensorByValueInfo(graph.input[i]);
    }
    for (let i = 0; i < graph.output.length; ++i) {
      this._addTensorByValueInfo(graph.output[i]);
    }
  }

  _addInputsOutputs() {
    const graph = this._rawModel.graph;
    let inputs = [this._getTensorIdByName(graph.node[0].input[0])];
    let outputs = [this._getTensorIdByName(graph.output[0].name)];
    if (this._options.softmax &&
        graph.node[graph.node.length-1].opType !== 'Softmax')
      outputs = [this._getTensorIdByName('softmax_appended')];
    this._model.identifyInputsAndOutputs(inputs, outputs);
  }

  _addTensorByValueInfo(valueInfo) {
    const name = valueInfo.name;
    if (this._tensorIds[name])
      throw new Error(`Tensor ${name} is already added`);

    const tensorType = valueInfo.type.tensorType;
    let dims = tensorType.shape.dim.map(dim => dim.dimValue);
    if (dims.length == 4) {
      // NCHW -> NHWC
      let nchw = Array.from(dims);
      dims[0] = nchw[0];
      dims[1] = nchw[2];
      dims[2] = nchw[3];
      dims[3] = nchw[1];
    }

    let type;
    switch (tensorType.elemType) {
      case onnx.TensorProto.DataType.FLOAT: {
        type = this._nn.TENSOR_FLOAT32;
      } break;
      case onnx.TensorProto.DataType.INT64:
      case onnx.TensorProto.DataType.INT32: {
        type = this._nn.TENSOR_INT32;
      } break;
      default: {
        throw new Error(`tensor type ${tensorType.elemType} is not supported.`);
      }
    }
    dims = dims.length ? Array.from(dims) : [1]; // scalars have shape []
    const operandType = {type: type, dimensions: dims};
    const tensorId = this._addNewTensorOperand(name, operandType);

    // set operand value
    const initializer = getObjectByName(this._rawModel.graph.initializer, name);
    if (initializer) {
      let data = getTensorData(initializer);
      this._setOperandValue(tensorId, data);
      console.log(`set operand ${name} data ${data.length}`);
    }
    return tensorId;
  }

  _setOperandValue(index, value) {
    // Cache operand value. It could be modified later: BN fusion/Unsqueeze
    this._operands[index] = value;
  }

  _setOperandType(index, type) {
    // Cache operand type. It could be modified later: Depthwise Conv
    this._tensorTypes[index] = type;
  }

  _addOperand(type, value) {
    let index = this._operandIndex++;
    // Cache operand type. It could be modified later: Depthwise Conv
    this._tensorTypes.push(type);
    if (typeof value !== 'undefined')
      this._setOperandValue(index, value);
    return index;
  }

  _addOperation(opCode, inputs, outputs) {
    // Cache operaion. It depends on operands that have not yet been added
    this._operations.push([opCode, inputs, outputs]);
    this._requiredOps.add(opCode);
  }

  _addNewTensorOperand(name, type, value) {
    if (this._tensorIds.hasOwnProperty(name)) {
      let index = this._tensorIds[name];
      if (typeof value !== 'undefined') {
        this._setOperandValue(index, value);
      }
      return index;
    }
    let index = this._addOperand(type, value);
    this._tensorIds[name] = {id: index, type: type};
    return index;
  }

  _addScalarInt32(value) {
    return this._addOperand({type: this._nn.INT32}, new Int32Array([value]));
  }

  _addScalarFloat32(value) {
    return this._addOperand({type: this._nn.FLOAT32}, new Float32Array([value]));
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

  _getTensorIdByName(name) {
    let info = this._tensorIds[name];
    if (typeof info === 'undefined')
      throw new Error(`Tensor ${name} is not found`);
    return info.id;
  }

  _getTensorTypeByName(name) {
    let info = this._tensorIds[name];
    if (typeof info === 'undefined')
      throw new Error(`Tensor ${name} is not found`);
    return info.type;
  }

  _addOpsAndParams(lastNode) {
    const graph = this._rawModel.graph;
    let i;
    if (typeof lastNode === 'undefined') {
      lastNode = graph.node.length - 1;
    }
    for (i = 0; i <= lastNode; ++i) {
      let node = graph.node[i];
      console.log(`opType: ${node.opType}`);
      let opCode;
      let inputs = [];
      let outputs = [];
      switch(node.opType) {
        case 'Conv': {
          // Add inputs
          console.log(`  inputs: [${node.input}]`);
          const input = node.input[0];
          const convFilter = node.input[1];
          const convBias = node.input[2];
          const convFilterType = this._getTensorTypeByName(convFilter);
          const nGroups = getAttributeValue(node, 'group', 1);
          const dims = convFilterType.dimensions;
          const nChannels = dims[0];
          const convFilterId = this._getTensorIdByName(convFilter);
          const convBiasId = typeof convBias !== 'undefined' ? // optional bias
            this._getTensorIdByName(convBias) :
            this._addTensorFloat32(new Array(nChannels).fill(0), [nChannels]);
          inputs.push(this._getTensorIdByName(input));
          inputs.push(convFilterId);
          inputs.push(convBiasId);

          const kernelShape = getAttributeValue(node, 'kernel_shape');
          if (!kernelShape || kernelShape.length !== 2)
            throw new Error('Invalid kernelShape');
          const kernelHeight = kernelShape[0];
          const kernelWidth = kernelShape[1];

          const pads = getAttributeValue(node, 'pads', [0, 0, 0, 0]);
          if (pads.length !== 4)
            throw new Error('Invalid pads');
          console.log(`  pads: [${pads}]`);
          const paddingHeightBegin = pads[0];
          const paddingWidthBegin = pads[1];
          const paddingHeightEnd = pads[2];
          const paddingWidthEnd = pads[3];
          inputs.push(this._addScalarInt32(paddingWidthBegin));
          inputs.push(this._addScalarInt32(paddingWidthEnd));
          inputs.push(this._addScalarInt32(paddingHeightBegin));
          inputs.push(this._addScalarInt32(paddingHeightEnd));

          const strides = getAttributeValue(node, 'strides');
          if (!strides || strides.length !== 2)
            throw new Error('Invalid strides');
          console.log(`  strides: [${strides}]`);
          const strideY = strides[0];
          const strideX = strides[1];
          inputs.push(this._addScalarInt32(strideX));
          inputs.push(this._addScalarInt32(strideY));

          let output = node.output[0];
          let nextNode = graph.node[i+1];

          // fuse batch norm preceded by a conv
          if (nextNode &&
            nextNode.opType === 'BatchNormalization' &&
            node.output[0] === nextNode.input[0]) {
            const bnNode = nextNode;
            const scale = bnNode.input[1];
            const bnBias = bnNode.input[2];
            const mean = bnNode.input[3];
            const variance = bnNode.input[4];
            const epsilon = getAttributeValue(bnNode, 'epsilon');

            const scaleTensor = this._getOperandValueByName(scale);
            const meanTensor = this._getOperandValueByName(mean);
            const varTensor = this._getOperandValueByName(variance);
            const bnBiasTensor = this._getOperandValueByName(bnBias);
            const convFilterTensor = this._getOperandValueByName(convFilter);
            const convBiasTensor = this._getOperandValue(convBiasId);

            const nPixels = product(dims.slice(1));
            for (let c = 0; c < nChannels; c++) {
              const w = scaleTensor[c] / Math.sqrt(varTensor[c] + epsilon);
              convBiasTensor[c] = bnBiasTensor[c] + (convBiasTensor[c] - meanTensor[c]) * w;
              for (let p = c * nPixels; p < (c+1) * nPixels; p++)
                convFilterTensor[p] *= w;
            }

            i++;
            node = bnNode;
            console.log(`  fuse batch norm: ${nextNode.output[0]} -> ${output}`);
            nextNode = graph.node[i+1];
            output = bnNode.output[0];
          }

          if (nextNode && nextNode.opType === 'Relu' && node.output[0] === nextNode.input[0]) {
            // Fuse relu
            inputs.push(this._addScalarInt32(this._nn.FUSED_RELU));
            i++;
            console.log(`  fuse relu: ${nextNode.output[0]} -> ${output}`);
            output = nextNode.output[0];
          } else {
            inputs.push(this._addScalarInt32(this._nn.FUSED_NONE));
          }

          // reshape kernel for depthwise conv
          const inputType = this._getTensorTypeByName(input);
          const inputChannels = inputType.dimensions[3];
          let isDepthWiseConv = false;
          if (nGroups > 1) {
            if (nGroups !== inputChannels)
              throw new Error('Group convolution is not supported.');
            else {
              isDepthWiseConv = true;
              console.log(`  groups: ${nGroups} (depthwise convolution)`);
              let nhwc = this._getOperandValueByName(convFilter);
              // NHWC -> CHWN where C === 1
              let chwnData = new Float32Array(nhwc.length);
              const N = dims[0];
              const H = dims[1];
              const W = dims[2];
              for (let n = 0; n < N; ++n)
                for (let h = 0; h < H; ++h)
                  for (let w = 0; w < W; ++w)
                    chwnData[h*W*N + w*N + n] = nhwc[n*H*W + h*W + w];

              this._setOperandValue(convFilterId, chwnData);
              convFilterType.dimensions[0] = 1;
              convFilterType.dimensions[3] = nGroups;

              // set multiplier to 1, not used in onnx model
              inputs.splice(9, 0, this._addScalarInt32(1));
            }
          }

          // Add outputs
          const batch = inputType.dimensions[0];
          const inputHeight = inputType.dimensions[1];
          const inputWidth = inputType.dimensions[2];
          const outputHeight = Math.floor((inputHeight - kernelHeight + paddingHeightBegin + paddingHeightEnd)/strideY + 1);
          const outputWidth = Math.floor((inputWidth - kernelWidth + paddingWidthBegin + paddingWidthEnd)/strideX + 1);
          const outputChannels = isDepthWiseConv ? nGroups : nChannels;
          const outputDims = [batch, outputHeight, outputWidth, outputChannels];
          const outputType = {type: this._nn.TENSOR_FLOAT32, dimensions: outputDims};
          const outputId = this._addNewTensorOperand(output, outputType);
          outputs.push(outputId);
          console.log(`  output ${output}: [${outputDims}]`);

          opCode = isDepthWiseConv ? this._nn.DEPTHWISE_CONV_2D : this._nn.CONV_2D;
        } break;
        case 'BatchNormalization': {
          // Add inputs
          console.log(`  inputs: [${node.input}]`);
          const input = node.input[0];
          const scale = node.input[1];
          const bnBias = node.input[2];
          const mean = node.input[3];
          const variance = node.input[4];
          const epsilon = getAttributeValue(node, 'epsilon');

          const scaleTensor = this._getOperandValueByName(scale);
          const meanTensor = this._getOperandValueByName(mean);
          const varTensor = this._getOperandValueByName(variance);
          const bnBiasTensor = this._getOperandValueByName(bnBias);

          // Conv with identity kernel
          const inputType = this._getTensorTypeByName(input);
          const nChannels = inputType.dimensions[3];
          const convFilterTensor = new Float32Array(nChannels * nChannels).fill(0);
          const convBiasTensor = new Float32Array(nChannels).fill(0);
          const convFilterDims = [nChannels, 1, 1, nChannels];
          const convBiasDims = [nChannels];

          for (let c = 0; c < nChannels; c++) {
            const w = scaleTensor[c] / Math.sqrt(varTensor[c] + epsilon);
            convFilterTensor[c * nChannels + c] = w;
            convBiasTensor[c] = bnBiasTensor[c] - w * meanTensor[c];
          }

          inputs.push(this._getTensorIdByName(input));
          inputs.push(this._addTensorFloat32(convFilterTensor, convFilterDims));
          inputs.push(this._addTensorFloat32(convBiasTensor, convBiasDims));
          // paddings
          inputs.push(this._addScalarInt32(0));
          inputs.push(this._addScalarInt32(0));
          inputs.push(this._addScalarInt32(0));
          inputs.push(this._addScalarInt32(0));
          // strides
          inputs.push(this._addScalarInt32(1));
          inputs.push(this._addScalarInt32(1));

          const nextNode = graph.node[i+1];
          let output = node.output[0];
          if (nextNode && nextNode.opType === 'Relu' && node.output[0] === nextNode.input[0]) {
            // Fuse relu
            inputs.push(this._addScalarInt32(this._nn.FUSED_RELU));
            i++;
            console.log(`  fuse relu: ${nextNode.output[0]} -> ${output}`);
            output = nextNode.output[0];
          } else {
            inputs.push(this._addScalarInt32(this._nn.FUSED_NONE));
          }

          // Add outputs
          const outputDims = Array.from(inputType.dimensions);
          const outputType = {type: this._nn.TENSOR_FLOAT32, dimensions: outputDims};
          const outputId = this._addNewTensorOperand(output, outputType);
          outputs.push(outputId);
          console.log(`  output ${output}: [${outputDims}]`);

          opCode = this._nn.CONV_2D;
        } break;
        case 'Relu': {
          // Add inputs
          console.log(`  inputs: [${node.input}]`);
          const input = node.input[0];

          // Conv with identity kernel
          const inputType = this._getTensorTypeByName(input);
          const nChannels = inputType.dimensions[3];
          const convFilterTensor = new Float32Array(nChannels * nChannels).fill(0);
          const convBiasTensor = new Float32Array(nChannels).fill(0);
          const convFilterDims = [nChannels, 1, 1, nChannels];
          const convBiasDims = [nChannels];

          for (let c = 0; c < nChannels; c++)
            convFilterTensor[c * nChannels + c] = 1;

          inputs.push(this._getTensorIdByName(input));
          inputs.push(this._addTensorFloat32(convFilterTensor, convFilterDims));
          inputs.push(this._addTensorFloat32(convBiasTensor, convBiasDims));
          // paddings
          inputs.push(this._addScalarInt32(0));
          inputs.push(this._addScalarInt32(0));
          inputs.push(this._addScalarInt32(0));
          inputs.push(this._addScalarInt32(0));
          // strides
          inputs.push(this._addScalarInt32(1));
          inputs.push(this._addScalarInt32(1));
          inputs.push(this._addScalarInt32(this._nn.FUSED_RELU));

          // Add outputs
          const output = node.output[0];
          const outputDims = Array.from(inputType.dimensions);
          const outputType = {type: this._nn.TENSOR_FLOAT32, dimensions: outputDims};
          const outputId = this._addNewTensorOperand(output, outputType);
          outputs.push(outputId);
          console.log(`  output ${output}: [${outputDims}]`);

          opCode = this._nn.CONV_2D;
        } break;
        case 'Mul':
        case 'Sum':
        case 'Add': 
        case 'Sub': 
        case 'Div': {
          if (node.opType === 'Sum' && node.input.length !== 2) {
            throw new Error(`Only support Sum with two inputs`);
          }

          // Add inputs
          console.log(`  inputs: [${node.input}]`);
          const in1 = node.input[0];
          const in2 = node.input[1];
          inputs.push(this._getTensorIdByName(in1));
          inputs.push(this._getTensorIdByName(in2));

          const nextNode = graph.node[i+1];
          let output = node.output[0];
          if (nextNode && nextNode.opType === 'Relu' && node.output[0] === nextNode.input[0]) {
            // Fuse relu
            inputs.push(this._addScalarInt32(this._nn.FUSED_RELU));
            i++;
            console.log(`  fuse relu: ${nextNode.output[0]} -> ${output}`);
            output = nextNode.output[0];
          } else {
            inputs.push(this._addScalarInt32(this._nn.FUSED_NONE));
          }

          // Add outputs
          const in1Type = this._getTensorTypeByName(in1);
          const in2Type = this._getTensorTypeByName(in2);
          const in1Dims = in1Type.dimensions;
          const in2Dims = in2Type.dimensions;

          // Compatible dims (multidirectional broadcasting)
          const outputDims = new Array(Math.max(in1Dims.length, in2Dims.length));
          for (let i = in1Dims.length - 1, j = in2Dims.length - 1, k = outputDims.length - 1; k >= 0;) {
            let dim1 = in1Dims[i--] || 1;
            let dim2 = in2Dims[j--] || 1;
            if (dim1 !== dim2 && dim1 !== 1 && dim2 !== 1)
              throw new Error(`Dimensions of ${in1} and ${in2} are not compatible`);
            outputDims[k--] = Math.max(dim1, dim2);
          }

          const outputType = {type: this._nn.TENSOR_FLOAT32, dimensions: Array.from(outputDims)};
          const outputId = this._addNewTensorOperand(output, outputType);
          outputs.push(outputId);
          console.log(`  output ${output}: [${outputDims}]`);

          if (node.opType === 'Add' || node.opType === 'Sum')
            opCode = this._nn.ADD;
          else if (node.opType === 'Mul')
            opCode = this._nn.MUL;
          else if (node.opType === 'Sub')
            opCode = this._nn.SUB;
          else
            opCode = this._nn.DIV;
        } break;
        case 'Pow': {
          // Add inputs
          console.log(`  inputs: [${node.input}]`);
          const in1 = node.input[0];
          const in2 = node.input[1];
          inputs.push(this._getTensorIdByName(in1));
          inputs.push(this._getTensorIdByName(in2));
          // Add outputs
          const output = node.output[0];
          const inputType = this._getTensorTypeByName(in1);
          const outputType = inputType;
          const outputId = this._addNewTensorOperand(output, outputType);
          outputs.push(outputId);
          
          opCode = this._nn.POW;
        } break;
        case 'Gemm': {
          // Add inputs
          console.log(`  inputs: [${node.input}]`);
          const input = node.input[0];    // A
          const weights = node.input[1];  // B
          const bias = node.input[2];     // C
          let alpha  = getAttributeValue(node, 'alpha',  1);
          let beta   = getAttributeValue(node, 'beta',   1);
          let transA = getAttributeValue(node, 'transA', 0);
          let transB = getAttributeValue(node, 'transB', 0);

          if (alpha !== 1 || beta !== 1 || transA || !transB)
            throw new Error('Only support fc-like Gemm oprations, i.e. alpha == beta == 1 && !transA && transB');

          inputs.push(this._getTensorIdByName(input));
          inputs.push(this._getTensorIdByName(weights));
          inputs.push(this._getTensorIdByName(bias));

          const nextNode = graph.node[i+1];
          let output = node.output[0];
          if (nextNode && nextNode.opType === 'Relu' && node.output[0] === nextNode.input[0]) {
            // Fuse relu
            inputs.push(this._addScalarInt32(this._nn.FUSED_RELU));
            i++;
            console.log(`  fuse relu: ${nextNode.output[0]} -> ${output}`);
            output = nextNode.output[0];
          } else {
            inputs.push(this._addScalarInt32(this._nn.FUSED_NONE));
          }

          // Add outputs
          const inputType = this._getTensorTypeByName(input);
          const weightsType = this._getTensorTypeByName(weights);
          const nUnits = weightsType.dimensions[0];
          const batchSize = product(inputType.dimensions) / weightsType.dimensions[1];
          const outputDims = [batchSize, nUnits];
          const outputType = {type: this._nn.TENSOR_FLOAT32, dimensions: outputDims};
          const outputId = this._addNewTensorOperand(output, outputType);
          outputs.push(outputId);
          console.log(`  output ${output}: [${outputDims}]`);

          opCode = this._nn.FULLY_CONNECTED;
        } break;
        case 'AveragePool':
        case 'MaxPool': {
          console.log(`  inputs: [${node.input}]`);
          const x = node.input[0];
          inputs.push(this._getTensorIdByName(x));

          const pads = getAttributeValue(node, 'pads', [0, 0, 0, 0]);
          if (pads.length !== 4)
            throw new Error('Invalid pads');
          console.log(`  pads: [${pads}]`);
          const paddingHeightBegin = pads[0];
          const paddingWidthBegin = pads[1];
          const paddingHeightEnd = pads[2];
          const paddingWidthEnd = pads[3];
          inputs.push(this._addScalarInt32(paddingWidthBegin));
          inputs.push(this._addScalarInt32(paddingWidthEnd));
          inputs.push(this._addScalarInt32(paddingHeightBegin));
          inputs.push(this._addScalarInt32(paddingHeightEnd));

          const strides = getAttributeValue(node, 'strides');
          if (!strides || strides.length !== 2)
            throw new Error('Invalid strides');
          console.log(`  strides: [${strides}]`);
          const strideY = strides[0];
          const strideX = strides[1];
          inputs.push(this._addScalarInt32(strideX));
          inputs.push(this._addScalarInt32(strideY));

          const kernelShape = getAttributeValue(node, 'kernel_shape');
          if (!kernelShape || kernelShape.length !== 2)
            throw new Error('Invalid kernelShape');
          const kernelHeight = kernelShape[0];
          const kernelWidth = kernelShape[1];
          inputs.push(this._addScalarInt32(kernelWidth));
          inputs.push(this._addScalarInt32(kernelHeight));
          inputs.push(this._addScalarInt32(this._nn.FUSED_NONE));

          // Add outputs
          const output = node.output[0];
          const inputType = this._getTensorTypeByName(x);
          const batch = inputType.dimensions[0];
          const inputHeight = inputType.dimensions[1];
          const inputWidth = inputType.dimensions[2];
          const inputChannels = inputType.dimensions[3];
          const outputHeight = Math.floor((inputHeight - kernelHeight + paddingHeightBegin + paddingHeightEnd)/strideY + 1);
          const outputWidth = Math.floor((inputWidth - kernelWidth + paddingWidthBegin + paddingWidthEnd)/strideX + 1);
          const outputDims = [batch, outputHeight, outputWidth, inputChannels];
          const outputType = {type: this._nn.TENSOR_FLOAT32, dimensions: outputDims};
          const outputId = this._addNewTensorOperand(output, outputType);
          outputs.push(outputId);
          console.log(`  output ${output}: [${outputDims}]`);

          if (node.opType === 'MaxPool')
            opCode = this._nn.MAX_POOL_2D;
          else if (node.opType === 'AveragePool')
            opCode = this._nn.AVERAGE_POOL_2D;
        } break;
        case 'Concat': {
          console.log(`  inputs: [${node.input}]`);
          for (let i = 0; i < node.input.length; ++i) {
            inputs.push(this._getTensorIdByName(node.input[i]));
          }
          const axis = getAttributeValue(node, 'axis');
          if (axis && (axis > 3 || axis < 0)) {
            throw new Error(`Invalid axis ${axis}`);
          }

          const input0Type = this._getTensorTypeByName(node.input[0]);
          const inputDims = input0Type.dimensions;
          let concatAxis = axis;
          if (inputDims.length === 4) {
            // NCHW -> NHWC
            concatAxis = {
              0: 0,
              1: 3,
              2: 1,
              3: 2,
            }[axis];
          }
          inputs.push(this._addScalarInt32(concatAxis));
          console.log(`  concatAxis: ${concatAxis}`);

          // Add output
          const output = node.output[0];
          let outputDims = Array.from(inputDims);
          for (let i = 1; i < node.input.length; ++i) {
            const inputType = this._getTensorTypeByName(node.input[i]);
            outputDims[concatAxis] += inputType.dimensions[concatAxis];
          }
          const outputType = {type: this._nn.TENSOR_FLOAT32, dimensions: outputDims};
          const outputId = this._addNewTensorOperand(output, outputType);
          outputs.push(outputId);
          console.log(`  output ${output}: [${outputDims}]`);

          opCode = this._nn.CONCATENATION;
        } break;
        case 'Dropout': {
          console.log(`Skip Dropout: ${node.input[0]} -> ${node.output[0]}`);
          this._tensorIds[node.output[0]] = this._tensorIds[node.input[0]];
        } break;
        case 'GlobalAveragePool': {
          console.log(`  inputs: [${node.input}]`);
          const x = node.input[0];
          inputs.push(this._getTensorIdByName(x));
          // paddings
          inputs.push(this._addScalarInt32(0));
          inputs.push(this._addScalarInt32(0));
          inputs.push(this._addScalarInt32(0));
          inputs.push(this._addScalarInt32(0));
          // strides
          inputs.push(this._addScalarInt32(1));
          inputs.push(this._addScalarInt32(1));
          // filters
          const inputType = this._getTensorTypeByName(x);
          const batch = inputType.dimensions[0];
          const inputHeight = inputType.dimensions[1];
          const inputWidth = inputType.dimensions[2];
          const inputChannels = inputType.dimensions[3];
          const kernelHeight = inputHeight;
          const kernelWidth = inputWidth;
          inputs.push(this._addScalarInt32(inputWidth));
          inputs.push(this._addScalarInt32(inputHeight));
          inputs.push(this._addScalarInt32(this._nn.FUSED_NONE));

          // Add outputs
          const output = node.output[0];
          const outputHeight = 1;
          const outputWidth = 1;
          const outputDims = [batch, outputHeight, outputWidth, inputChannels];
          const outputType = {type: this._nn.TENSOR_FLOAT32, dimensions: outputDims};
          const outputId = this._addNewTensorOperand(output, outputType);
          outputs.push(outputId);
          console.log(`  output ${output}: [${outputDims}]`);

          opCode = this._nn.AVERAGE_POOL_2D;
        } break;
        case 'Constant': {
          const name = node.output[0];
          const shapeTensor = getAttributeValue(node, 'value');
          const shapeData = getTensorData(shapeTensor);
          const shapeType = {type: this._nn.TENSOR_INT32, dimensions: Array.from(shapeTensor.dims)};
          this._addNewTensorOperand(name, shapeType, shapeData);
        } break;
        case 'Reshape': {
          console.log(`  inputs: [${node.input}]`);
          const input = node.input[0];
          const shape = node.input[1];
          const inputId = this._getTensorIdByName(input);
          const shapeId = this._getTensorIdByName(shape);
          inputs.push(inputId);
          inputs.push(shapeId);

          let inputDims = this._getTensorTypeByName(input).dimensions;
          let outputDims = this._getOperandValue(shapeId);
          // dim == 0 means actual dim is unchanged, i.e. taken from the inputDim
          outputDims = outputDims.map((d, i) => d === 0 ? inputDims[i] : d);
          // At most one dimension of the new shape can be -1
          const minusOneCnt = outputDims.filter(x => x === -1).length;
          if (minusOneCnt === 1) {
            const nonAdaptDim = outputDims.filter(x => x !== -1);
            const adaptDimIdx = outputDims.indexOf(-1);
            outputDims[adaptDimIdx] = product(inputDims) / product(nonAdaptDim);
          } else if (minusOneCnt !== 0)
            throw new Error(`Invalid shape ${outputDims}`);
          this._setOperandValue(shapeId, outputDims);

          // Add outputs
          const output = node.output[0];
          const outputType = {type: this._nn.TENSOR_FLOAT32, dimensions: outputDims};
          const outputId = this._addNewTensorOperand(output, outputType);
          outputs.push(outputId);
          console.log(`  output ${output}: [${outputDims}]`);
          opCode = this._nn.RESHAPE;
        } break;
        case 'Transpose': {
          console.log(`  inputs: [${node.input}]`);
          const input = node.input[0];
          const inputDims = this._getTensorTypeByName(input).dimensions;
          const perm = getAttributeValue(node, 'perm', []);
          if (!perm.length) {
            for (let i = inputDims.length - 1; i >= 0; i--) {
              perm.push(i);
            }
          }

          inputs.push(this._getTensorIdByName(input));
          inputs.push(this._addTensorInt32(perm, [perm.length]));

          // Add outputs
          const output = node.output[0];
          const outputDims = [];
          for (const axis of perm) {
            outputDims.push(inputDims[axis]);
          }
          const outputType = {type: this._nn.TENSOR_FLOAT32, dimensions: outputDims};
          const outputId = this._addNewTensorOperand(output, outputType);
          outputs.push(outputId);
          console.log(`  output ${output}: [${outputDims}]`);
          opCode = this._nn.TRANSPOSE;
        } break;
        case 'Flatten': {
          console.log(`  inputs: [${node.input}]`);
          const input = node.input[0];
          const axis = getAttributeValue(node, 'axis', 1);
          const inputId = this._getTensorIdByName(input);
          inputs.push(inputId);

          const inputDims = this._getTensorTypeByName(input).dimensions;
          const rank = inputDims.length;
          if (axis > rank || axis < 0) {
            throw new Error(`Axis ${axis} is not in the range [0, ${rank}]`);
          }
          let outputDim1 = inputDims.slice(0, axis);
          outputDim1 = outputDim1.length ? product(outputDim1) : 1;
          let outputDim2 = inputDims.slice(axis);
          outputDim2 = outputDim2.length ? product(outputDim2) : 1;
          const outputDims =  [outputDim1, outputDim2];

          const shapeType = {type: this._nn.TENSOR_INT32, dimensions: [2]};
          const shapeId = this._addNewTensorOperand(`shape_${name}`, shapeType, new Int32Array(outputDims));
          inputs.push(shapeId);

          // Add outputs
          const output = node.output[0];
          const outputType = {type: this._nn.TENSOR_FLOAT32, dimensions: Array.from(outputDims)};
          const outputId = this._addNewTensorOperand(output, outputType);
          outputs.push(outputId);
          console.log(`  output ${output}: [${outputDims}]`);
          opCode = this._nn.RESHAPE;
        } break;
        case 'Unsqueeze': {
          const input = node.input[0];
          const inputDims = this._getTensorTypeByName(input).dimensions;
          const axes = getAttributeValue(node, 'axes');
          for (let i of axes) {
            inputDims.splice(i, 0, 1);
          }
          // (N)CHW -> (N)HWC
          const C = inputDims.splice(inputDims.length-3, 1)[0];
          inputDims.push(C);
          const output = node.output[0];
          this._tensorIds[output] = this._tensorIds[input];
          console.log(`Skip Unsqueeze: ${input} -> ${output}`);
        } break;
        case 'Neg': {
          console.log(`  inputs: [${node.input}]`);
          const input = node.input[0];
          inputs.push(this._getTensorIdByName(input));
          inputs.push(this._addTensorFloat32([-1], [1]));
          inputs.push(this._addScalarInt32(this._nn.FUSED_NONE));

          // Add outputs
          const output = node.output[0];
          const outputDims =  this._getTensorTypeByName(input).dimensions;
          const outputType = {type: this._nn.TENSOR_FLOAT32, dimensions: Array.from(outputDims)};
          const outputId = this._addNewTensorOperand(output, outputType);
          outputs.push(outputId);
          console.log(`  output ${output}: [${outputDims}]`);
          opCode = this._nn.MUL;
        } break;
        case 'Softmax': {
          console.log(`  inputs: [${node.input}]`);
          const input = node.input[0];
          inputs.push(this._getTensorIdByName(input));
          // Set beta to 1.0
          inputs.push(this._addScalarFloat32(1.0));
          const output = node.output[0];
          const inputType = this._getTensorTypeByName(input);
          const outputType = {type: this._nn.TENSOR_FLOAT32, dimensions: inputType.dimensions};
          const outputId = this._addNewTensorOperand(output, outputType);
          outputs.push(outputId);

          opCode = this._nn.SOFTMAX;
        } break;
        case 'Pad': {
          // opset = 8 (ai.onnx v8)
          console.log(`  inputs: [${node.input}]`);
          const input = node.input[0];
          inputs.push(this._getTensorIdByName(input));
          const inputDims =  this._getTensorTypeByName(input).dimensions;
          const padMode = getAttributeValue(node, 'mode', 'constant');
          let paddingModeCode = 0;
          // paddingModeCode
          paddingModeCode = {
            'constant': 0,
            'reflect': 1,
            'edge': 2,
          }[padMode];
          inputs.push(this._addScalarInt32(paddingModeCode));
          const pads = getAttributeValue(node, 'pads', []);
          if (inputDims.length === 4 && pads.length === 8) {
            // ONNX pads (NCHW) -> TensorFlow paddings (NHWC)
            let paddings = [];
            for (let i = 0; i < pads.length; i++) {
              paddings.push({
                0: pads[0],  //N Before
                1: pads[4],  //N After
                2: pads[2],  //H Before
                3: pads[6],  //H After
                4: pads[3],  //W Before
                5: pads[7],  //W After
                6: pads[1],  //C Before
                7: pads[5],  //C After
              }[i]);
            }
            inputs.push(this._addTensorInt32(paddings, [4, 2]));
            // Add outputs
            const output = node.output[0];
            const outputDimsN = inputDims[0] + paddings[0] + paddings[1];
            const outputDimsH = inputDims[1] + paddings[2] + paddings[3];
            const outputDimsW = inputDims[2] + paddings[4] + paddings[5];
            const outputDimsC = inputDims[3] + paddings[6] + paddings[7];
            const outputDims = [outputDimsN, outputDimsH, outputDimsW, outputDimsC];
            const outputType = {type: this._nn.TENSOR_FLOAT32, dimensions: outputDims};
            const outputId = this._addNewTensorOperand(output, outputType);
            outputs.push(outputId);
          } else {
            throw new Error(`    ${node.opType} (Dims = ${inputDims}) is not supported.`);
          }

          opCode = this._nn.PAD;
        } break;
        case 'ReduceMean': {
          console.log(`  inputs: [${node.input}]`);
          const input = node.input[0];
          inputs.push(this._getTensorIdByName(input));
          const axes = getAttributeValue(node, 'axes');
          const inputDims =  this._getTensorTypeByName(input).dimensions;
          if (inputDims.length === 4) {
            // NCHW -> NHWC
            let meanAxes = [];
            for (let i = 0; i < axes.length; i++) {
              meanAxes.push({
                0: 0,
                1: 3,
                2: 1,
                3: 2,
              }[axes[i]]);
            }
            inputs.push(this._addTensorInt32(meanAxes, [meanAxes.length]));
            const keepdims = getAttributeValue(node, 'keepdims');
            inputs.push(this._addScalarInt32(keepdims));
            // Add outputs
            const output = node.output[0];
            const N = meanAxes.includes(0) ? 1 : inputDims[0];
            const H = meanAxes.includes(1) ? 1 : inputDims[1];
            const W = meanAxes.includes(2) ? 1 : inputDims[2];
            const C = meanAxes.includes(3) ? 1 : inputDims[3];
            const outputDims = [N, H, W, C];
            const outputType = {type: this._nn.TENSOR_FLOAT32, dimensions: outputDims};
            const outputId = this._addNewTensorOperand(output, outputType);
            outputs.push(outputId);
          } else {
            throw new Error(`    ${node.opType} (Dims = ${inputDims}) is not supported.`);
          }

          opCode = this._nn.MEAN;
        } break;
        case 'ConvTranspose': {
          console.log(`  inputs: [${node.input}]`);
          const input = node.input[0];
          const weights = node.input[1];
          let inputType = this._getTensorTypeByName(input);
          const inputDims = inputType.dimensions;
          const inputBatch = inputDims[0];
          const inputInDepth = inputDims[3];
          let weightsType = this._getTensorTypeByName(weights);
          const weightsDims =  weightsType.dimensions;
          const weightsInDepth = weightsDims[0];
          const weightsOutDepth = weightsDims[3];
          if (inputInDepth !== weightsInDepth) {
            throw new Error(`  inDepth in weights must match inDepth in input.`);
          }          
          inputs.push(this._getTensorIdByName(input));
          // inDepth x H x W x outDepth -> [H, W, outDepth, inDepth]
          const weightsId = this._getTensorIdByName(weights);
          const weightsTensor = this._getOperandValue(weightsId);
          let weightsArray = new Float32Array(weightsTensor.length);
          const I = weightsDims[0];
          const H = weightsDims[1];
          const W = weightsDims[2];
          const O = weightsDims[3];
          for (let i = 0; i < I; ++i) {
            for (let h = 0; h < H; ++h) {
              for (let w = 0; w < W; ++w) {
                for (let o = 0; o < O; ++o) {
                  weightsArray[h*W*O*I + w*O*I + o*I + i] = weightsTensor[i*H*W*O + h*W*O + w*O + o];
                }
              }
            }
          }
          weightsType.dimensions.push(weightsType.dimensions.shift());
          this._setOperandType(weightsId, weightsType);
          this._setOperandValue(weightsId, weightsArray);
          inputs.push(weightsId);

          const outputShapeHW = getAttributeValue(node, 'output_shape');
          const outputShape = [inputBatch, outputShapeHW[0], outputShapeHW[1], weightsOutDepth];
          const strides = getAttributeValue(node, 'strides');
          inputs.push(this._addTensorInt32(outputShape, [outputShape.length]));
          inputs.push(this._addTensorInt32(strides, [strides.length]));
          // Add outputs
          const output = node.output[0];
          const outputType = {type: this._nn.TENSOR_FLOAT32, dimensions: outputShape};
          const outputId = this._addNewTensorOperand(output, outputType);
          outputs.push(outputId);

          opCode = this._nn.TRANSPOSE_CONV_2D;
        } break;
        case 'Tanh': {
          console.log(`  inputs: [${node.input}]`);
          const input = node.input[0];
          inputs.push(this._getTensorIdByName(input));
          // Add outputs
          const output = node.output[0];
          const outputDims =  this._getTensorTypeByName(input).dimensions;
          const outputType = {type: this._nn.TENSOR_FLOAT32, dimensions: outputDims};
          const outputId = this._addNewTensorOperand(output, outputType);
          outputs.push(outputId);

          opCode = this._nn.TANH;
        } break;
        default: {
          throw new Error(`    ${node.opType} is not supported.`);
        }
      }

      // skip NOP, e.g. Constant
      if (typeof opCode === 'undefined')
        continue;

      if (i === graph.node.length - 1) {

        // redirect the output of the last node to the existing tensor bound to
        // the node in the graph, i.e. output tensor given by the user
        outputs = [this._getTensorIdByName(graph.output[0].name)];

        if (this._options.softmax && node.opType !== 'Softmax') {
          this._addOperation(opCode, inputs, outputs);

          console.log(`opType: Softmax (appended automatically)`);
          console.log(`  inputs: [${node.output[0]}]`);
          // Add inputs
          inputs = [];
          inputs.push(outputs[0]);
          // Set beta to 1.0
          inputs.push(this._addScalarFloat32(1.0));

          // Add outputs
          outputs = [];
          const inputType = this._getTensorTypeByName(node.output[0]);
          const outputType = {type: this._nn.TENSOR_FLOAT32, dimensions: inputType.dimensions};
          const outputId = this._addNewTensorOperand('softmax_appended', outputType);
          outputs.push(outputId);

          opCode = this._nn.SOFTMAX;
        }
      }

      this._addOperation(opCode, inputs, outputs);
    }

    // Write back all cached operands and operations
    for (const type of this._tensorTypes) {
      this._model.addOperand(type);
    }
    for (const [index, value] of Object.entries(this._operands)) {
      this._model.setOperandValue(index, value);
    }
    for (const [opCode, inputs, outputs] of this._operations) {
      this._model.addOperation(opCode, inputs, outputs);
    }
    return i - 1;
  }

  getRequiredOps() {
    return this._requiredOps;
  }
}
