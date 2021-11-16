
class OpenVINOUtils {
  static async loadOpenVINOModel() {
    let networkFile = '';
    let weightsFile = '';
    const argc = Array.from(arguments).length;
    if (argc === 1) {
      networkFile = arguments[0] + '.xml';
      weightsFile = arguments[0] + '.bin';
    } else if (argc === 2) {
      networkFile = arguments[0];
      weightsFile = arguments[1];
    } else {
      throw new Error('Invalid arguments.');
    }
    const networkText = await fetch(networkFile).then((res) => res.text());
    const weightsBuffer = await fetch(weightsFile).then((res) => res.arrayBuffer());
    return new OpenVINOModel(networkText, weightsBuffer);
  }

  static product(arr) {
    return arr.reduce((x, y) => x * y);
  }
}
