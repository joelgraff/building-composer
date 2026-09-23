/**
 * Export helpers for the Building Composer model.
 */

import { GLTFExporter } from '../node_modules/three/examples/jsm/exporters/GLTFExporter.js';

/**
 * Export a scene or object to a `.glb` binary buffer.
 *
 * @param {THREE.Object3D} object - Root object to export.
 * @returns {Promise<ArrayBuffer>}
 */
export function exportGlb(object) {
  return new Promise((resolve, reject) => {
    const exporter = new GLTFExporter();
    const hiddenObjects = [];

    object.traverse((child) => {
      if (child.userData.editorOnly) {
        hiddenObjects.push(child);
        child.visible = false;
      }
    });

    exporter.parse(
      object,
      (result) => {
        hiddenObjects.forEach((child) => {
          child.visible = true;
        });
        if (result instanceof ArrayBuffer) {
          resolve(result);
        } else {
          const encoder = new TextEncoder();
          const blob = encoder.encode(JSON.stringify(result));
          resolve(blob.buffer);
        }
      },
      (error) => {
        hiddenObjects.forEach((child) => {
          child.visible = true;
        });
        reject(error);
      },
      { binary: true }
    );
  });
}
