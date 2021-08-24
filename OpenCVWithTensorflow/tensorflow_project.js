import '@tensorflow/tfjs-backend-cpu';
import '@tensorflow/tfjs-backend-webgl';

import * as cocoSsd from '@tensorflow-models/coco-ssd';

let modelPromise;

window.onload = () => modelPromise = cocoSsd.load();

const select = document.getElementById('base_model');
select.onchange = async (event) => {

    console.log("base_model onchange");

    const model = await modelPromise;
    model.dispose();
    modelPromise = cocoSsd.load(
        { base: event.srcElement.options[event.srcElement.selectedIndex].value });

    console.log("base_model onchange end");
};