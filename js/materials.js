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
  paint: { label: 'Painted white', color: 0xf1eee6, roughness: 0.7, metalness: 0 },
  black: { label: 'Painted black', color: 0x2e3236, roughness: 0.6, metalness: 0 },
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
  const wall = new THREE.MeshStandardMaterial({
    color: wallPreset.color,
    roughness: wallPreset.roughness,
    metalness: wallPreset.metalness,
    side: THREE.DoubleSide,
  });
  wall.userData = { role: 'wall', palette: MATERIAL_PALETTE[config.wallMaterial] ? config.wallMaterial : 'wood' };
  const foundation = MATERIALS.foundation.clone();
  foundation.userData = { role: 'foundation' };
  const roof = MATERIALS.roof.clone();
  roof.userData = { role: 'roof' };
  // a walk-in interior's surfaces (see js/interior.js)
  const interiorSurface = (color, role) => {
    const material = new THREE.MeshStandardMaterial({
      color, roughness: 0.9, metalness: 0, side: THREE.DoubleSide,
    });
    material.userData = { role };
    return material;
  };
  const interiorWall = interiorSurface(0xebe6dc, 'interior-wall');
  const interiorFloor = interiorSurface(0x9c7a55, 'interior-floor');
  const interiorCeiling = interiorSurface(0xf4f1ea, 'interior-ceiling');
  return {
    wall,
    foundation,
    roof,
    interiorWall,
    interiorFloor,
    interiorCeiling,
    outline: MATERIALS.outline.clone(),
    ground: MATERIALS.ground.clone(),
  };
}

/** A material made from a palette entry, remembering which one (the game export maps it). */
export function paletteMaterial(key, role) {
  const preset = MATERIAL_PALETTE[key] ?? MATERIAL_PALETTE.wood;
  const material = new THREE.MeshStandardMaterial({
    color: preset.color,
    roughness: preset.roughness,
    metalness: preset.metalness,
    side: THREE.DoubleSide,
  });
  material.userData = { role, palette: MATERIAL_PALETTE[key] ? key : 'wood' };
  return material;
}

/**
 * A window's pane. Kept as its own factory rather than a MATERIAL_PALETTE
 * entry: glazing needs transparency the opaque wall presets don't, so it
 * doesn't fit paletteMaterial's uniform opaque factory. Fixed for v1 — no
 * user-facing glazing choice yet.
 */
export function glazingMaterial() {
  const material = new THREE.MeshStandardMaterial({
    color: 0xcfe3ea,
    transparent: true,
    opacity: 0.35,
    roughness: 0.05,
    metalness: 0.1,
    side: THREE.DoubleSide,
  });
  material.userData = { role: 'glass', palette: 'glass' };
  return material;
}
