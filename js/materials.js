/**
 * Shared material definitions for the building massing model.
 */

import * as THREE from '../node_modules/three/build/three.module.js';

export const MATERIAL_PALETTE = Object.freeze({
  brick: { label: 'Brick', color: 0x9b5542, roughness: 0.9, metalness: 0.02 },
  wood: { label: 'Wood', color: 0xc99561, roughness: 0.82, metalness: 0.02 },
  stucco: { label: 'Stucco', color: 0xd8d0c2, roughness: 0.95, metalness: 0 },
  metal: { label: 'Metal', color: 0x66727c, roughness: 0.42, metalness: 0.65 },
  stone: { label: 'Stone', color: 0x8d8880, roughness: 0.94, metalness: 0.01 },
});

export const MATERIALS = Object.freeze({
  wall: new THREE.MeshStandardMaterial({
    color: 0xd9c1a3,
    roughness: 0.88,
    metalness: 0.06,
    side: THREE.DoubleSide,
  }),
  foundation: new THREE.MeshStandardMaterial({
    color: 0x7d736d,
    roughness: 0.92,
    metalness: 0.04,
    side: THREE.DoubleSide,
  }),
  roof: new THREE.MeshStandardMaterial({
    color: 0xc7c0b5,
    roughness: 0.9,
    metalness: 0.08,
    side: THREE.DoubleSide,
  }),
  outline: new THREE.LineBasicMaterial({
    color: 0x3d5f9a,
    linewidth: 1,
  }),
  ground: new THREE.MeshStandardMaterial({
    color: 0xe3e6ec,
    roughness: 1,
    metalness: 0,
  }),
});

export function createMaterials(config = {}) {
  const wallPreset = MATERIAL_PALETTE[config.wallMaterial] ?? MATERIAL_PALETTE.wood;
  return {
    wall: new THREE.MeshStandardMaterial({
      color: wallPreset.color,
      roughness: wallPreset.roughness,
      metalness: wallPreset.metalness,
      side: THREE.DoubleSide,
    }),
    foundation: MATERIALS.foundation.clone(),
    roof: MATERIALS.roof.clone(),
    outline: MATERIALS.outline.clone(),
    ground: MATERIALS.ground.clone(),
  };
}
