import * as tf from '@tensorflow/tfjs-core';
import { FuseCode, OperandCode, OperationCode, PaddingCode, PreferenceCode } from '../Enums';
import Graph from '../GraphUtils';
import * as utils from '../utils';
import CyclicProfiler from '../instrument';
import wasmPath from '../../../node_modules/@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm.wasm';
import simdPath from '../../../node_modules/@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-simd.wasm';
import threadedSimdPath from '../../../node_modules/@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-threaded-simd.wasm';
import {setWasmPaths} from '@tensorflow/tfjs-backend-wasm';
import "@tensorflow/tfjs-backend-webgl";

var warmUpRuns = 1;

export default class TfjsModel {
  /**
   * Create TfjsModel class in nn/Model.js
   *
   * @param {Object} model - Model from nn/Model.js
   */
  constructor(model) {
    this._nnNative = navigator.ml.getNeuralNetworkContext();
    this._supportedOps = new Set([]);
    this._model = model;
    this._subgraphs = [];
    this._operands = [];
    this._nnOperands = [];  // copies of input/output tensors of WebNN subgraph
    this._preference = PreferenceCode.FAST_SINGLE_ANSWER;
    this._prepared = false;
    this._profiler = null;
    this._isOpenVINOModel = model.isOpenVINOModel || false;
  }

  /** Called in nn/Compilation.js */
  async prepareModel() {
    switch (this._model._backend) {
      case ('WASM'): {
        if (tf.getBackend() != 'wasm') {
          // Assume the wasm file is located in the same folder as webml-polyfill.js
          const wasmPathPrefix = window.location.protocol + "//" + window.location.host + "/dist/";
          setWasmPaths(wasmPathPrefix);
          await tf.setBackend('wasm');
        };
      } break;
      case ('WebGPU'): {
        while (tf.getBackend() != 'webgpu') {
          await tf.setBackend('webgpu');
          await tf.ready();
        }
      } break;
      case ('WebGL'): {
        while (tf.getBackend() != 'webgl') {
          await tf.setBackend('webgl');
          await tf.ready();
        }
      } break;
      default: {
        throw new Error(`Backend ${this._model._backend} is not supported`);
      }
    }

    const model = this._model;
    const operations = model._operations;

    this._preference = model._preference;
    this._supportedOps = model._supportedOps;
    this._eager = model._eager;

    const graph = new Graph(operations.length);
    operations.forEach((op, i) => {
      graph.addNode(i, op.inputs, op.outputs);
      if (!this._supportedOps.has(op.type)) {
        // mark unsupported ops black
        graph.setBlack(i);
      }
    });
    graph.identifyInputOutputTensors(model._inputs, model._outputs);
    const partitions = graph.partition(this._eager);

    for (const [i, { nodes, inTensors, outTensors }] of partitions.entries()) {

      // Test if the first op in the partition (nodes[0]) is supported natively
      const isSupportedByNN = this._supportedOps.has(operations[nodes[0]].type);

      // summary of the partiton. e.g. "CONV x 5, ADD x 2, MUL x 2"
      const ops = nodes.map((opId) => operations[opId]);
      const summary = utils.stringifySubgraphCompact(model, nodes);
      const backendName = isSupportedByNN ? 'WebNN' : 'Tfjs';

      if (!isSupportedByNN) {

        // run with tfjs

        // create tensor from typedArray
        for (const operation of ops) {
          for (const tensorId of [...operation.inputs, ...operation.outputs]) {
            if (!!this._operands[tensorId]) continue;
            const operand = this._model._operands[tensorId];
            if (utils.isTensor(operand.type)) {
              const type = this._getOperandType(operand.type);
              if (operand.value !== null) {
                // constant tensor
                let typedArray;
                let raw = operand.value;
                if (this._model._backend === 'WASM' && raw.buffer.byteLength != raw.byteLength) {
                  let part = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
                  if (type === 'float32') {
                    typedArray = new Float32Array(part);
                  } else {
                    typedArray = new Int32Array(part);
                  }
                } else {
                  typedArray = raw;
                }
                this._operands[tensorId] =
                  tf.tensor(typedArray, operand.dimensions, type);
              } else {
                // variable tensor
                const zeroTensor = tf.zeros(operand.dimensions, type);
                this._operands[tensorId] = tf.variable(zeroTensor);
                zeroTensor.dispose();
              }
            } else {
              this._operands[tensorId] = operand;
            }
          }
          this._changeWeightsFormat(operation);
        }

        // allocate JS buffers for model outputs
        // outputs of the last Tfjs partition are also model outputs
        if (i === partitions.length - 1) {
          for (const tensorId of outTensors) {
            if (!this._nnOperands.hasOwnProperty(tensorId)) {
              const tensor = this._model._operands[tensorId];
              const typedArray = utils.operandCodeToTypedArrayMap.get(tensor.type);
              this._nnOperands[tensorId] = new typedArray(utils.product(tensor.dimensions));
            }
          }
        }

        this._subgraphs.push({
          backend: backendName,
          inputs: inTensors,
          outputs: outTensors,
          operations: ops,
          summary: summary,
        });

      } else {

        // run in WebNN

        // allocate placeholders for WebNN operands copies.
        for (const tensorId of [...inTensors, ...outTensors]) {
          if (!this._nnOperands.hasOwnProperty(tensorId)) {
            const tensor = this._model._operands[tensorId];
            const typedArray = utils.operandCodeToTypedArrayMap.get(tensor.type);
            this._nnOperands[tensorId] = new typedArray(utils.product(tensor.dimensions));
          }
        }

        // create WebNN model
        const { model, compilation, execution } =
          await this._createSubModel(nodes, inTensors, outTensors);

        this._subgraphs.push({
          backend: backendName,
          summary: summary,
          inputs: inTensors,
          outputs: outTensors,
          model: model,             // avoid GC   intel/webml-polyfill#669
          compilation: compilation, // avoid GC   intel/webml-polyfill#669
          execution: execution,
        });
      }
    }

    this._profiler = new CyclicProfiler(this._subgraphs.length, warmUpRuns);
    this._prepared = true;
  }

  /**
   * Called in nn/Execution.js
   *
   * @param {Map} inputs
   * @param {Map} outputs
   */
  async execute(inputs, outputs) {
    if (!this._prepared) {
      throw new Error('Model is not prepared');
    }

    // wire up WebNN input tensors
    inputs.forEach((input) => {
      this._nnOperands[input.index] = input.buffer;
    });

    if (this._subgraphs[0].backend === 'Tfjs') {
      // upload inputs to Tfjs
      inputs.forEach(input => {
        let operand = this._operands[input.index];
        const inputTensor =
          tf.tensor(input.buffer, operand.shape, operand.dtype);
        operand.assign(inputTensor);
        inputTensor.dispose();
      });
    }

    for (const subgraph of this._subgraphs) {
      this._profiler.startEvent();
      if (subgraph.backend === 'WebNN') {
        await this._executeNNSubgraph(subgraph);
      } else {
        await this._executeSubgraph(subgraph);
      }
      this._profiler.endEvent();
    }

    // fill output tensors
    outputs.forEach((output) => {
      const operand = this._nnOperands[output.index];
      output.buffer.set(operand);
    });
  }

  async _createSubModel(nodes, inTensors, outTensors) {

    // create a WebNN model
    const submodel = await this._nnNative.createModel();

    // since tensorId of a subgraph should start from 0, we use it to
    // maintain a mapping from global tensor Id to local tensor Id
    const globalIdToLocalId = {};

    // counter for local tensor Id
    let operandIndex = 0;

    for (const operationId of nodes) {
      const operation = this._model._operations[operationId];

      // allocate input and output tensors for each operation
      for (const tensorId of [...operation.inputs, ...operation.outputs]) {
        const globalTensorId = parseInt(tensorId);

        // E.g., tensor A -> Node 1 -> tensor B -> Node 2 -> tensor C
        // At the time of Node 2, its input tensor B may have already been
        // allocated by the time Node 1 was processed. So we check if the
        // `globalTensorId` is already in the map.
        if (!globalIdToLocalId.hasOwnProperty(globalTensorId)) {
          const localTensorId = operandIndex++;
          globalIdToLocalId[globalTensorId] = localTensorId;
          const operand = this._model._operands[globalTensorId];
          const operandType = {
            type: operand.type,
            dimensions: operand.dimensions,
            scale: operand.scale,
            zeroPoint: operand.operand,
          };
          submodel.addOperand(operandType);
          if (operand.value) {
            submodel.setOperandValue(localTensorId, operand.value);
          }
        }
      }

      // add the operation to the submodel
      const operationInputs = operation.inputs.map(i => globalIdToLocalId[i]);
      const operationOutputs = operation.outputs.map(i => globalIdToLocalId[i]);
      submodel.addOperation(operation.type, operationInputs, operationOutputs);
    }

    // indentify the input and output tensors of the submodel
    const submodelInputs = inTensors.map(i => globalIdToLocalId[i]);
    const submodelOutputs = outTensors.map(i => globalIdToLocalId[i]);
    submodel.identifyInputsAndOutputs(submodelInputs, submodelOutputs);
    await submodel.finish();

    const compilation = await submodel.createCompilation();
    compilation.setPreference(this._preference);
    await compilation.finish();

    const execution = await compilation.createExecution();

    // set output tensor buffers at compile time
    outTensors.forEach((tensorId, i) => {
      execution.setOutput(i, this._nnOperands[tensorId]);
    });

    return { model: submodel, compilation: compilation, execution: execution };
  }

  async _executeNNSubgraph(subgraph) {
    const inputs = subgraph.inputs;
    const outputs = subgraph.outputs;
    const execution = subgraph.execution;
    const nnOperands = this._nnOperands;
    const glOperands = this._operands;

    // workaround for intel/webml-polyfill#674
    inputs.forEach((tensorId, i) => {
      const buffer = nnOperands[tensorId];
      execution.setInput(i, buffer);
    });

    // execute subgraph
    await execution.startCompute();

    outputs.forEach(tensorId => {
      // sync data to Tfjs if needed
      if (glOperands.hasOwnProperty(tensorId)) {
        const buffer = nnOperands[tensorId];
        const operand = glOperands[tensorId];
        const tmpTensor = tf.tensor(buffer, operand.shape, operand.dtype);
        operand.assign(tmpTensor);
        tmpTensor.dispose();
      }
    });
  }

  async _executeSubgraph(subgraph) {
    for (const operation of subgraph.operations) {
      tf.tidy(() => this._executeOperation(operation));
    }

    // fence
    // const queue = [];
    for (const tensorId of subgraph.outputs) {
      const buffer = this._nnOperands[tensorId];
      const operand = this._operands[tensorId];
      buffer.set(await operand.data());
      // const promise = operand.data().then((data) => buffer.set(data));
      // queue.push(promise);
    }
    // await Promise.all(queue);
  }

  _executeOperation(operation) {
    const op = operation.type;
    const inputs = operation.inputs;
    const outputs = operation.outputs;
    const operands = this._operands;
    const layout = this._isOpenVINOModel ? 'NCHW' : 'NHWC';

    const FuseFunctionMap = new Map([
      [FuseCode.NONE, x => x],
      [FuseCode.RELU, tf.relu],
      [FuseCode.RELU1, x => tf.clipByValue(x, -1, 1)],
      [FuseCode.RELU6, x => tf.clipByValue(x, 0, 6)]
    ]);

    const PaddingCodeMap = new Map([
      [PaddingCode.SAME, 'same'],
      [PaddingCode.VALID, 'valid']
    ]);

    switch (op) {
      case OperationCode.ADD:
      case OperationCode.MUL:
      case OperationCode.SUB:
      case OperationCode.DIV: {
        const input1 = operands[inputs[0]];
        const input2 = operands[inputs[1]];
        const activation = FuseFunctionMap.get(operands[inputs[2]].value[0]);
        const output = operands[outputs[0]];
        if (op === OperationCode.ADD) {
          output.assign(activation(tf.add(input1, input2)));
        } else if (op === OperationCode.MUL) {
          output.assign(activation(tf.mul(input1, input2)));
        } else if (op === OperationCode.SUB) {
          output.assign(activation(tf.sub(input1, input2)));
        } else {
          output.assign(activation(tf.div(input1, input2)));
        }
      } break;
      case OperationCode.POW: {
        const input1 = operands[inputs[0]];
        const input2 = operands[inputs[1]];
        const output = operands[outputs[0]];
        output.assign(tf.pow(input1, input2));
      } break;
      case OperationCode.CONV_2D:
      case OperationCode.ATROUS_CONV_2D: {
        const inCount = inputs.length;

        if (this._isOpenVINOModel) {
          if (inCount !== 8 && inCount !== 11) {
            throw new Error(`Invalid parameters number of Conv2d ${op}`);
          }
        } else {
          if (inCount !== 7 && inCount !== 10) {
            throw new Error(`Invalid parameters number of Conv2d ${op}`);
          }
        }

        let i = 0;
        let input = operands[inputs[i++]];
        let filter = operands[inputs[i++]];
        let bias = operands[inputs[i++]];
        let output = operands[outputs[0]];
        let strideW, strideH;
        let dilationW, dilationH;
        let activation;
        if (inCount === 7) {
          const paddingCode = operands[inputs[i++]].value[0];
          const padding = PaddingCodeMap.get(paddingCode);
          if (op === OperationCode.CONV_2D) {
            strideW = operands[inputs[i++]].value[0];
            strideH = operands[inputs[i++]].value[0];
            [dilationW, dilationH] = [1, 1];
          } else {
            dilationW = operands[inputs[i++]].value[0];
            dilationH = operands[inputs[i++]].value[0];
            [strideW, strideH] = [1, 1];
          }
          activation = FuseFunctionMap.get(operands[inputs[i++]].value[0]);
          output.assign(activation(
            input.conv2d(filter, [strideH, strideW],
              padding, 'NHWC',
              [dilationH, dilationW])
              .add(bias)));
        } else {
          const paddingLeft = operands[inputs[i++]].value[0];
          const paddingRight = operands[inputs[i++]].value[0];
          const paddingTop = operands[inputs[i++]].value[0];
          const paddingBottom = operands[inputs[i++]].value[0];
          if (op === OperationCode.CONV_2D) {
            strideW = operands[inputs[i++]].value[0];
            strideH = operands[inputs[i++]].value[0];
            [dilationW, dilationH] = [1, 1];
          } else {
            dilationW = operands[inputs[i++]].value[0];
            dilationH = operands[inputs[i++]].value[0];
            [strideW, strideH] = [1, 1];
          }
          activation = FuseFunctionMap.get(operands[inputs[i++]].value[0]);

          if (layout === 'NCHW') {
            // nchw -> nhwc;
            input = input.transpose([0, 2, 3, 1]);
            if (bias.shape.length === 4) {
              // nchw -> nhwc;
              bias = bias.transpose([0, 2, 3, 1])
            }
          }

          if (this._isPaddingEqual(paddingLeft, paddingRight,
            paddingTop, paddingBottom)) {
            if (layout == 'NCHW') {
              output.assign(activation(
                input.conv2d(filter, [strideH, strideW],
                  paddingLeft, 'NHWC',
                  [dilationH, dilationW], 'floor').add(bias).transpose([0, 3, 1, 2])));
            } else {
              output.assign(activation(
                input.conv2d(filter, [strideH, strideW],
                  paddingLeft, 'NHWC',
                  [dilationH, dilationW], 'floor').add(bias)));
            }
          } else {
            if (layout == 'NCHW') {
              output.assign(activation(
                input.pad([[0, 0], [paddingTop, paddingBottom],
                [paddingLeft, paddingRight], [0, 0]])
                  .conv2d(filter, [strideH, strideW],
                    'valid', 'NHWC',
                    [dilationH, dilationW])
                  .add(bias).transpose([0, 3, 1, 2])));
            } else {
              output.assign(activation(
                input.pad([[0, 0], [paddingTop, paddingBottom],
                [paddingLeft, paddingRight], [0, 0]])
                  .conv2d(filter, [strideH, strideW],
                    'valid', 'NHWC',
                    [dilationH, dilationW])
                  .add(bias)));
            }
          }
        }
      } break;
      case OperationCode.DEPTHWISE_CONV_2D:
      case OperationCode.ATROUS_DEPTHWISE_CONV_2D: {
        const inCount = inputs.length;

        if (this._isOpenVINOModel) {
          if (inCount !== 9 && inCount !== 12) {
            throw new Error(
              `Invalid parameters number of DepthwiseConv2d ${op}`);
          }
        } else {
          if (inCount !== 8 && inCount !== 11) {
            throw new Error(
              `Invalid parameters number of DepthwiseConv2d ${op}`);
          }
        }

        let i = 0;
        let input = operands[inputs[i++]];
        const filter = operands[inputs[i++]];
        let bias = operands[inputs[i++]];
        let output = operands[outputs[0]];
        let strideW, strideH;
        let dilationW, dilationH;
        let depthMultipler;
        let activation;
        // pad input if inputChannels is less than filterChannels
        const inputChannels = layout === 'NCHW' ? input.shape[1] : input.shape[3];
        const filterChannels = filter.shape[2];
        if (layout === 'NCHW') {
          // nchw -> nhwc;
          input = input.transpose([0, 2, 3, 1]);
          if (bias.shape.length === 4) {
            // nchw -> nhwc;
            bias = bias.transpose([0, 2, 3, 1])
          }
        }
        if (inputChannels < filterChannels) {
          input = input.pad([[0, 0], [0, 0],
          [0, 0], [0, filterChannels - inputChannels]]);
        }
        if (inCount === 8) {
          const paddingCode = operands[inputs[i++]].value[0];
          const padding = PaddingCodeMap.get(paddingCode);
          if (op === OperationCode.DEPTHWISE_CONV_2D) {
            strideW = operands[inputs[i++]].value[0];
            strideH = operands[inputs[i++]].value[0];
            [dilationW, dilationH] = [1, 1];
          } else {
            dilationW = operands[inputs[i++]].value[0];
            dilationH = operands[inputs[i++]].value[0];
            [strideW, strideH] = [1, 1];

          }
          depthMultipler = operands[inputs[i++]].value[0];
          activation = FuseFunctionMap.get(operands[inputs[i++]].value[0]);
          output.assign(activation(
            input.depthwiseConv2D(filter, [strideH, strideW],
              padding, 'NHWC',
              [dilationH, dilationW])
              .add(bias)));
        } else {
          const paddingLeft = operands[inputs[i++]].value[0];
          const paddingRight = operands[inputs[i++]].value[0];
          const paddingTop = operands[inputs[i++]].value[0];
          const paddingBottom = operands[inputs[i++]].value[0];
          if (op === OperationCode.DEPTHWISE_CONV_2D) {
            strideW = operands[inputs[i++]].value[0];
            strideH = operands[inputs[i++]].value[0];
            [dilationW, dilationH] = [1, 1];
          } else {
            dilationW = operands[inputs[i++]].value[0];
            dilationH = operands[inputs[i++]].value[0];
            [strideW, strideH] = [1, 1];
          }
          depthMultipler = operands[inputs[i++]].value[0];
          activation = FuseFunctionMap.get(operands[inputs[i++]].value[0]);
          if (this._isPaddingEqual(paddingLeft, paddingRight,
            paddingTop, paddingBottom)) {
            if (layout == 'NCHW') {
              output.assign(activation(
                input.depthwiseConv2D(filter, [strideH, strideW],
                  paddingLeft, 'NHWC',
                  [dilationH, dilationW], 'floor')
                  .add(bias).transpose([0, 3, 1, 2])));
            } else {
              output.assign(activation(
                input.depthwiseConv2D(filter, [strideH, strideW],
                  paddingLeft, 'NHWC',
                  [dilationH, dilationW], 'floor')
                  .add(bias)));
            }
          } else {
            if (layout == 'NCHW') {
              output.assign(activation(
                input.pad([[0, 0], [paddingTop, paddingBottom],
                [paddingLeft, paddingRight], [0, 0]])
                  .depthwiseConv2D(filter, [strideH, strideW],
                    'valid', 'NHWC',
                    [dilationH, dilationW])
                  .add(bias).transpose([0, 3, 1, 2])));
            } else {
              output.assign(activation(
                input.pad([[0, 0], [paddingTop, paddingBottom],
                [paddingLeft, paddingRight], [0, 0]])
                  .depthwiseConv2D(filter, [strideH, strideW],
                    'valid', 'NHWC',
                    [dilationH, dilationW])
                  .add(bias)));
            }
          }
        }
      } break;
      case OperationCode.AVERAGE_POOL_2D:
      case OperationCode.MAX_POOL_2D: {
        const inCount = inputs.length;

        if (this._isOpenVINOModel) {
          if (inCount !== 8 && inCount !== 11) {
            throw new Error(`Invalid parameters number of Pooling ${op}`);
          }
        } else {
          if (inCount !== 7 && inCount !== 10) {
            throw new Error(`Invalid parameters number of Pooling ${op}`);
          }
        }

        let i = 0;
        let input = operands[inputs[i++]];
        let output = operands[outputs[0]];
        if (layout === 'NCHW') {
          // nchw -> nhwc;
          input = input.transpose([0, 2, 3, 1]);
        }
        let strideW, strideH;
        let filterW, filterH;
        let activation;
        if (inCount === 7) {
          const paddingCode = operands[inputs[i++]].value[0];
          const padding = PaddingCodeMap.get(paddingCode);
          strideW = operands[inputs[i++]].value[0];
          strideH = operands[inputs[i++]].value[0];
          filterW = operands[inputs[i++]].value[0];
          filterH = operands[inputs[i++]].value[0];
          activation = FuseFunctionMap.get(operands[inputs[i++]].value[0]);
          if (this._model._backend === 'WASM' && filterH === 1 && filterW === 1) {
            let inputData;
            const [N, H, W, C] = output.shape;
            const [NI, HI, WI, CI] = input.shape;
            if (padding === 'same') {
              const paddingLeft = Math.floor(((W - 1) * strideW + filterW - WI) / 2);
              const paddingRight = ((W - 1) * strideW + filterW - WI) - paddingLeft;
              const paddingTop = Math.floor(((H - 1) * strideH + filterH - HI) / 2);
              const paddingBottom = ((H - 1) * strideH + filterH - HI) - paddingTop;
              inputData = input.pad([[0, 0], [paddingTop, paddingBottom],
              [paddingLeft, paddingRight], [0, 0]]).dataSync();
            } else {
              inputData = input.dataSync()
            }
            let outputData = this._downSampling(input, output, inputData, strideH, strideW);
            output.assign(activation(tf.tensor(outputData, output.shape)));
          } else {
            if (op === OperationCode.AVERAGE_POOL_2D) {
              output.assign(activation(
                input.avgPool([filterH, filterW],
                  [strideH, strideW],
                  padding)));
            } else {
              output.assign(activation(
                input.maxPool([filterH, filterW],
                  [strideH, strideW],
                  padding)));
            }
          }
        } else {
          const paddingLeft = operands[inputs[i++]].value[0];
          const paddingRight = operands[inputs[i++]].value[0];
          const paddingTop = operands[inputs[i++]].value[0];
          const paddingBottom = operands[inputs[i++]].value[0];
          strideW = operands[inputs[i++]].value[0];
          strideH = operands[inputs[i++]].value[0];
          filterW = operands[inputs[i++]].value[0];
          filterH = operands[inputs[i++]].value[0];
          activation = FuseFunctionMap.get(operands[inputs[i++]].value[0]);
          if (this._model._backend === 'WASM' && filterH === 1 && filterW === 1) {
            let inputData = input.pad([[0, 0], [paddingTop, paddingBottom],
            [paddingLeft, paddingRight], [0, 0]]).dataSync();
            let outputData = this._downSampling(input, output, inputData, strideH, strideW);
            output.assign(activation(tf.tensor(outputData, output.shape)));
          } else {
            if (this._isPaddingEqual(paddingLeft, paddingRight,
              paddingTop, paddingBottom)) {
              if (op === OperationCode.AVERAGE_POOL_2D) {
                if (layout == 'NCHW') {
                  output.assign(activation(input.avgPool([filterH, filterW],
                    [strideH, strideW],
                    paddingLeft, 'floor').transpose([0, 3, 1, 2])));
                } else {
                  output.assign(activation(input.avgPool([filterH, filterW],
                    [strideH, strideW],
                    paddingLeft, 'floor')));
                }
              } else {
                if (layout == 'NCHW') {
                  output.assign(activation(input.maxPool([filterH, filterW],
                    [strideH, strideW],
                    paddingLeft, 'floor').transpose([0, 3, 1, 2])));
                } else {
                  output.assign(activation(input.maxPool([filterH, filterW],
                    [strideH, strideW],
                    paddingLeft, 'floor')));
                }
              }
            } else {
              if (op === OperationCode.AVERAGE_POOL_2D) {
                throw new Error(
                  'AVERAGE_POOL_2D with unequal padding is not supported');
              } else {
                if (layout == 'NCHW') {
                  output.assign(activation(
                    input.pad([[0, 0], [paddingTop, paddingBottom],
                    [paddingLeft, paddingRight], [0, 0]],
                      -1e8 /* a small enough constant */)
                      .maxPool([filterH, filterW],
                        [strideH, strideW],
                        'valid').transpose([0, 3, 1, 2])));
                } else {
                  output.assign(activation(
                    input.pad([[0, 0], [paddingTop, paddingBottom],
                    [paddingLeft, paddingRight], [0, 0]],
                      -1e8 /* a small enough constant */)
                      .maxPool([filterH, filterW],
                        [strideH, strideW],
                        'valid')));
                }
              }
            }
          }
        }
      } break;
      case OperationCode.SOFTMAX: {
        let input = operands[inputs[0]];
        const beta = operands[inputs[1]].value[0];
        let output = operands[outputs[0]];

        if (layout === 'NCHW') {
          switch (input.shape.length) {
            case 4: {
              // nchw -> nhwc;
              input = input.transpose([0, 2, 3, 1]);
            } break;
            case 3: {
              // chw -> hwc;
              input = input.transpose([1, 2, 0]);
            } break;
          }
        }
        let order = [];
        if (layout === 'NCHW') {
          switch (output.shape.length) {
            case 4: {
              // nhwc -> nchw;
              order =[0, 3, 1, 2];
            } break;
            case 3: {
              // hwc -> chw;
              order = [2, 0, 1];
            } break;
          }
        }
        if (beta === 1) {
          if (layout == 'NCHW' && output.shape.length > 2) {
            output.assign(input.softmax().transpose(order));
          } else {
            output.assign(input.softmax());
          }
        } else {
          if (layout == 'NCHW' && output.shape.length > 2) {
            output.assign(input.mul(tf.scalar(beta)).softmax().transpose(order));
          } else {
            output.assign(input.mul(tf.scalar(beta)).softmax());
          }
        }
      } break;
      case OperationCode.RESHAPE: {
        const input = operands[inputs[0]];
        const targetShape = operands[inputs[1]];
        const output = operands[outputs[0]];
        if (targetShape.value === undefined) {
          const operand = this._model._operands[inputs[1]];
          targetShape.value = operand.value;
        }
        output.assign(input.reshape(targetShape.value));
      } break;
      case OperationCode.CONCATENATION: {
        const numInputTensors = inputs.length - 1;
        const axis = operands[inputs[numInputTensors]].value[0];

        const output = operands[outputs[0]];
        let inputTensors = [];
        for (let i = 0; i < numInputTensors; ++i) {
          inputTensors.push(operands[inputs[i]]);
        }
        output.assign(tf.concat(inputTensors, axis));
      } break;
      case OperationCode.FULLY_CONNECTED: {
        const input = operands[inputs[0]];
        const weights = operands[inputs[1]];
        const bias = operands[inputs[2]];
        const activation = FuseFunctionMap.get(operands[inputs[3]].value[0]);
        const output = operands[outputs[0]];
        const batchSize = utils.product(input.shape) / weights.shape[1];
        output.assign(activation(
          input.reshape([batchSize, -1])
            .matMul(weights, false, true)
            .add(bias)));
      } break;
      case OperationCode.RESIZE_BILINEAR: {
        if (outputs.length < 1 || inputs.length < 3) {
          throw new Error('Invalid inputs or outputs');
        }
        let input = operands[inputs[0]];
        const newHeight = operands[inputs[1]].value[0];
        const newWidth = operands[inputs[2]].value[0];
        const output = operands[outputs[0]];
        let alignCorner = false;
        if (inputs.length === 4 || layout === 'NCHW') {
          alignCorner = operands[inputs[3]].value[0] !== 0;
        }
        if (layout === 'NCHW') {
          // nchw -> nhwc;
          input = input.transpose([0, 2, 3, 1]);
        }
        if (layout == 'NCHW') {
          output.assign(
            input.resizeBilinear([newHeight, newWidth], alignCorner).transpose([0, 3, 1, 2]));
        } else {
          output.assign(
            input.resizeBilinear([newHeight, newWidth], alignCorner));
        }
      } break;
      case OperationCode.TANH: {
        const input = operands[inputs[0]];
        const output = operands[outputs[0]];
        output.assign(input.tanh());
      } break;
      case OperationCode.BATCH_TO_SPACE_ND: {
        const input = operands[inputs[0]];
        const blockShape = operands[inputs[1]];
        const output = operands[outputs[0]];
        const crops = [[0, 0], [0, 0]];
        if (blockShape.value === undefined) {
          // blockShape.dataSync() return Int32Array,
          // which should be converted to Array here.
          const operand = this._model._operands[inputs[1]];
          blockShape.value = operand.value;
        }
        output.assign(input.batchToSpaceND(blockShape.value, crops));
      } break;
      case OperationCode.TRANSPOSE: {
        const input = operands[inputs[0]];
        const perm = operands[inputs[1]];
        const output = operands[outputs[0]];
        if (perm !== undefined) {
          if (perm.value === undefined) {
            const operand = this._model._operands[inputs[1]];
            perm.value = operand.value;
          }
          output.assign(input.transpose(perm.value));
        } else {
          output.assign(input.transpose());
        }
      } break;
      case OperationCode.ARGMAX: {
        const input1 = operands[inputs[0]];
        const input2 = operands[inputs[1]].value[0];
        const output = operands[outputs[0]];
        output.assign(tf.argMax(input1, input2));
      } break;
      case OperationCode.MAXIMUM: {
        const input1 = operands[inputs[0]];
        const input2 = operands[inputs[1]];
        const output = operands[outputs[0]];
        output.assign(tf.maximum(input1, input2));
      } break;
      case OperationCode.PRELU: {
        const input1 = operands[inputs[0]];
        const input2 = operands[inputs[1]];
        const output = operands[outputs[0]];
        output.assign(tf.prelu(input1, input2));
      } break;
      case OperationCode.LOGISTIC: {
        const input1 = operands[inputs[0]];
        const output = operands[outputs[0]];
        output.assign(tf.sigmoid(input1));
      } break;
      case OperationCode.PAD: { //reflect
        const input = operands[inputs[0]];
        const paddingModeCode = operands[inputs[1]];
        const paddings = operands[inputs[2]].arraySync();
        const output = operands[outputs[0]];
        output.assign(tf.pad(input, paddings));
      } break;
      case OperationCode.MEAN: {
        const input = operands[inputs[0]];
        const axes = operands[inputs[1]].arraySync();
        const keepdims = operands[inputs[2]].value[0];
        const output = operands[outputs[0]];
        output.assign(tf.mean(input, axes, keepdims));
      } break;
      case OperationCode.TRANSPOSE_CONV_2D: {
        const input = operands[inputs[0]];
        const filter = operands[inputs[1]];
        const outputShape = operands[inputs[2]].arraySync();
        const strides = operands[inputs[3]].arraySync();
        const output = operands[outputs[0]];
        output.assign(tf.conv2dTranspose(input, filter, outputShape, strides, 'same'));
      } break;
      case OperationCode.SQUARED_DIFFERENCE: {
        const input0 = operands[inputs[0]];
        const input1 = operands[inputs[1]];
        const output = operands[outputs[0]];
        output.assign(tf.squaredDifference(input0, input1));
      } break;
      default: {
        throw new Error(`Operation ${op} is not supported`);
      }
    }
  }

  /** Types supported in tfjs: float32, int32, bool, complex64 */
  _getOperandType(type) {
    if (type === OperandCode.TENSOR_FLOAT32) {
      return 'float32';
    } else if (type === OperandCode.TENSOR_INT32) {
      return 'int32';
    } else {
      throw new Error(`Operand type ${type} is not supported`);
    }
  }

  /** Change (depthwise) conv2d weights format. */
  _changeWeightsFormat(operation) {
    const layout = this._isOpenVINOModel ? 'NCHW' : 'NHWC';
    switch (operation.type) {
      case OperationCode.CONV_2D:
      case OperationCode.ATROUS_CONV_2D: {
        // [outChannels, filterH, filterW, inChannels]
        // => [filterH, filterW, inChannels, outChannels]
        // https://js.tensorflow.org/api/0.14.1/#conv2d
        const inputs = operation.inputs;
        const filter = this._operands[inputs[1]];
        if (layout === 'NCHW') {
          this._operands[inputs[1]] = filter.transpose([2, 3, 1, 0]);
        } else {
          this._operands[inputs[1]] = filter.transpose([1, 2, 3, 0]);
        }
        filter.dispose();
      } break;
      case OperationCode.DEPTHWISE_CONV_2D:
      case OperationCode.ATROUS_DEPTHWISE_CONV_2D: {
        // [1, filterH, filterW, outChannels]
        // => [filterH, filterW, inChannels, depthMultipler]
        // https://js.tensorflow.org/api/0.14.1/#depthwiseConv2d
        const inputs = operation.inputs;
        const filter = this._operands[inputs[1]];
        const filterH = filter.shape[1];
        const filterW = filter.shape[2];
        let depthMultipler;
        if (layout === 'NCHW') {
          depthMultipler =
            this._operands[inputs[inputs.length - 3]].value[0];
        } else {
          depthMultipler =
            this._operands[inputs[inputs.length - 2]].value[0];
        }
        if (layout === 'NCHW') {
          this._operands[inputs[1]] = filter.reshape([depthMultipler, -1, filterH, filterW])
            .transpose([2, 3, 1, 0]).reshape([filterH, filterW, -1, depthMultipler]);
        } else {
          this._operands[inputs[1]] =
            filter.reshape([filterH, filterW, -1, depthMultipler]);
        }
        filter.dispose();
      } break;
    }
  }

  /** patch code to enable pooling with filter 1×1 */
  _downSampling(input, output, inputData, strideH, strideW) {
    let [N, C, H, W] = output.shape;
    let [NI, CI, HI, WI] = input.shape;
    if (layout === 'NCHW') {
      [N, H, W, C] = output.shape;
      [NI, HI, WI, CI] = input.shape;
    }
    let outputData = new Float32Array(N * H * W * C);
    for (let n = 0; n < N; ++n) {
      for (let h = 0; h < H; ++h) {
        for (let w = 0; w < W; ++w) {
          for (let c = 0; c < C; ++c) {
            if (layout === 'NCHW') {
              outputData[n * H * W * C + h * W * C + w * h + w] = inputData[n * HI * WI * CI + h * strideH * WI * CI + h * strideH * W + w]
            } else {
              outputData[n * H * W * C + h * W * C + w * C + c] = inputData[n * HI * WI * CI + h * strideH * WI * CI + w * strideW * C + c];
          }
          }
        }
      }
    }
    return outputData;
  }

  _isPaddingEqual(left, right, top, bottom) {
    return (left === right) && (left === top) && (left === bottom);
  }

  _deleteAll() {
    this._operands.forEach(operand => {
      if (operand.isDisposed === false) {
        operand.dispose();
      }
    })
  }

  static _supportWebGL() {
    tf.setBackend('webgl');
    return tf.getBackend() === 'webgl';
  }

  static _supportWebGPU() {
    if (navigator.gpu === undefined) {
      return false;
    } else {
      let tfjsBackendWebgpu = require("@tensorflow/tfjs-backend-webgpu");
      tf.setBackend('webgpu');
      tf.ready();
      return tf.getBackend() === "webgpu";
    }
  }

  static _getBackend() {
    return tf.getBackend();
  }

  getSubgraphsSummary() {
    return this._subgraphs.map((graph, i) =>
      `Subgraph ${i}\t (${graph.backend}):\t{${graph.summary}}`);
  }

  dumpProfilingResults() {
    const res = this._profiler.flush();
    const timings = [];
    const supportedOps = Array.from(this._supportedOps)
      .map(op => utils.findKey(OperationCode, op));
    const mode = this._eager ? 'Eager' : 'Graph';

    if (res.epochs <= 0) {
      console.warn(`Report will be available after at least ${warmUpRuns + 1} executions.`);
    } else {
      for (const [i, { backend, summary }] of this._subgraphs.entries()) {
        const opTime = res.elpased[i];
        timings.push({
          backend: backend,
          summary: summary,
          elpased: opTime
        });
      }
    }

    return {
      mode: mode,
      warmUpRuns: warmUpRuns,
      epochs: res.epochs,
      supportedOps: supportedOps,
      timings: timings
    };
  }
}
