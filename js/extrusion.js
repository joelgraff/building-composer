/**
 * Extrusion helper that creates the base massing for the model.
 */

import * as THREE from '../node_modules/three/build/three.module.js';
import { createMaterials, MATERIAL_PALETTE, paletteMaterial, glazingMaterial } from './materials.js';
import { roofAxisForDirection, findVolumeAdjacencies, wallRunFrame } from './facade.js';
import {
  resolveOpening, openingOutline, structureOpeningHost, normalizeSteps, flightFor, doorStepPieces, doorStepRails, STEP_RAIL_INSET, FRAME_DEPTH, PANE_RECESS, FRAME_CASING_WIDTH, STEP_SIDE_MARGIN,
} from './openings.js';
import {
  normalizeTrim, normalizeWallTrim, courseOn, cornerTriangles, TRIM_KINDS, courseProfile, profileExtent, subtractIntervals, sweepCourse, dentilSize, dentilTriangles, floorLines,
} from './trim.js';
import {
  normalizeRailing, railingParts, partTriangles, TOP_RAIL,
} from './railings.js';
import {
  resolveVolumeEaves, sideOverhangs, buildGableTrim, buildHipTrim, buildShedTrim, buildPartialEaveStrips,
} from './eaves.js';
import {
  clipPolygon, polygonsToTriangles, FLAT_ROOF_THICKNESS, clipOutsideConvexSolid, clipInsideConvexSolid, planPrism, volumeSolid, isInsideSolid,
  validateRoofStructures, structureWallPolygons, structureWallSides, structureFloorPolygon, structureRecess, hostEaveProfile, hostEaveCovers,
  roofProfile, roofPeak, structureFacade, roofWalkFacade, zoneSolids, zoneRoofHeight, facadeWallRun, edgeFrame,
} from './roof-structures.js';
import {
  computeVolumeEavePlanes, defaultHighEdgeForAxis, evalPlaneHeight, evalZoneHeight, makeEavePlane, makeEdgePlane, TWO_SLOPE_ROOF_TYPES, twoSlopeSides,
} from './roof-planes.js';
import { buildCutRoof } from './cut-roofs.js';
import { detailParts, leafSpan, normalizeDetails } from './opening-details.js';
import {
  normalizeChimneys, chimneyPlan, chimneyParts, partTriangles as chimneyPartTriangles, CHIMNEY_REACH,
} from './chimneys.js';
import { gutterRing, downspoutParts, GUTTER_PROFILE } from './gutters.js';
import { postTriangles } from './posts.js';
import {
  normalizeInterior, insetOutline, shellTriangles, apertureSolid, apertureReveals, doorLeaf, CEILING_BAND,
} from './interior.js';

export { computeVolumeEavePlanes, evalZoneHeight };

let straightSkeletonBuilder = null;

/** Roofs sit this far above their wall top (see roofZoneDescriptor's `wallTopY`). */
const ROOF_LIFT = 0.02;

export function setStraightSkeletonBuilder(builder) {
  straightSkeletonBuilder = builder;
}

/**
 * Create a parametric box building from a footprint polygon.
 *
 * @param {Array<[number, number]>} footprint - X/Z footprint vertices.
 * @param {object} config - Building configuration.
 * @param {number} [config.storyCount=1]
 * @param {number} [config.storyHeight=3.2]
 * @param {number} [config.foundationDepth=0.6]
 * @param {number} [config.roofOverhang=0.2]
 * @param {number} [config.roofEaveDepth=0.35]
 * @param {'flat'|'gable'|'hip'|'shed'} [config.roofType='flat']
 * @param {'x'|'z'} [config.roofDirection='z']
 * @param {number} [config.roofHeight=2]
 * @param {number} [config.roofPitchRise=6]
 * @param {number} [config.roofPitchRun=12]
 * @returns {{ building: THREE.Group, foundationHeight: number, totalHeight: number }}
 */
export function createBuildingFromFootprint(footprint, config = {}) {
  const {
    storyCount = 1,
    storyHeight = 3.2,
    foundationDepth = 0.6,
    roofOverhang = 0.2,
    roofEaveDepth = roofOverhang,
    roofType = 'flat',
    roofDirection = 'z',
    roofHeight = 2,
    roofPitchRise = 6,
    roofPitchRun = 12,
  } = config;

  const volumes = config.volumes ?? [];
  const overrides = config.volumeStoryOverrides ?? {};
  const buildingWallHeight = volumeWallHeight(null, config);
  const levelConfig = { ...config, foundationDepth };
  const buildingFoundation = volumeFoundationHeight(null, levelConfig);
  const plateOf = (id) => volumeFoundationHeight(id, levelConfig) + volumeWallHeight(id, config);
  // volumes whose plates differ get their own roofs; ones level at the plate
  // share one roof, even over different floor levels (a garage at grade)
  const hasVolumeOverrides = volumes.length > 1
    && volumes.some((volume) => Math.abs(plateOf(volume.id) - (buildingFoundation + buildingWallHeight)) > 1e-9);
  const mixedFloors = volumes.length > 1
    && volumes.some((volume) => Math.abs(volumeFoundationHeight(volume.id, levelConfig) - buildingFoundation) > 1e-9);
  // a volume with its own wall material needs walls of its own
  const ownMaterials = volumes.length > 1 && volumes.some((volume) => MATERIAL_PALETTE[config.volumeMaterials?.[volume.id]]);
  // a walk-in interior hollows each volume's walls on their own
  const hollow = volumes.length > 0 && normalizeInterior(config.interior).enabled;

  if (hasVolumeOverrides) {
    return withStructuresAndWalks(createMultiVolumeBuilding(volumes, overrides, {
      wallMaterial: config.wallMaterial,
      kneeWallHeight: config.kneeWallHeight,
      volumeKneeWalls: config.volumeKneeWalls,
      volumeStoryHeights: config.volumeStoryHeights,
      volumeFoundationHeights: config.volumeFoundationHeights,
      storyCount, storyHeight, foundationDepth, roofEaveDepth, roofType, roofHeight, roofPitchRise, roofPitchRun, roofHeightMode: config.roofHeightMode, volumeRidgeDirections: config.volumeRidgeDirections, volumeRoofTypes: config.volumeRoofTypes, volumeRoofConnections: config.volumeRoofConnections, volumeRoofShapes: config.volumeRoofShapes,
      volumeMaterials: config.volumeMaterials,
      interior: config.interior,
      ...pickEaveConfig({ ...config, roofEaveDepth }),
    }), config);
  }

  const materials = createMaterials(config);
  const group = new THREE.Group();
  const totalHeight = buildingWallHeight;
  const foundationHeight = foundationDepth;
  const primaryRoofZone = config.roofZones?.[0];
  const resolvedRoofType = primaryRoofZone?.roofType ?? roofType;
  const resolvedRoofDirection = primaryRoofZone?.roofDirection ?? roofDirection;
  const resolvedRoofPitchRise = primaryRoofZone?.roofPitchRise ?? roofPitchRise;
  const resolvedRoofPitchRun = primaryRoofZone?.roofPitchRun ?? roofPitchRun;

  if (mixedFloors || ownMaterials || hollow) {
    // one roof over volumes on different floors, clad differently, or hollow: each its own walls, up to the shared plate
    volumes.forEach((volume) => {
      addVolumeBody(group, volume, {
        floorY: volumeFoundationHeight(volume.id, levelConfig), topY: foundationHeight + totalHeight, config: levelConfig, materials,
      });
    });
    cutPassages(group, volumes, materials);
  } else {
    const shape = buildShape(footprint, 0);
    const wallGeometry = new THREE.ExtrudeGeometry(shape, {
      depth: totalHeight,
      bevelEnabled: false,
      steps: 1,
      curveSegments: 12,
    });

    wallGeometry.rotateX(-Math.PI / 2);
    const walls = new THREE.Mesh(wallGeometry, materials.wall);
    walls.position.y = foundationHeight;
    walls.userData = { bodyPart: 'walls' };
    group.add(walls);

    const foundationShape = buildShape(footprint, 0);
    const foundationGeometry = new THREE.ExtrudeGeometry(foundationShape, {
      depth: foundationHeight,
      bevelEnabled: false,
      steps: 1,
      curveSegments: 12,
    });
    foundationGeometry.rotateX(-Math.PI / 2);
    const foundation = new THREE.Mesh(foundationGeometry, materials.foundation);
    foundation.position.y = 0;
    group.add(foundation);
  }

  const { geometry: roofGeometry, zones: roofZones, walks: skeletonWalks = [] } = createRoofGeometry(footprint, {
    roofType: resolvedRoofType,
    roofDirection: resolvedRoofDirection,
    roofHeight,
    roofOverhang: roofEaveDepth,
    roofPitchRise: resolvedRoofPitchRise,
    roofPitchRun: resolvedRoofPitchRun,
    volumes: config.volumes,
    volumeRidgeDirections: config.volumeRidgeDirections,
    volumeRoofTypes: config.volumeRoofTypes,
    volumeRoofConnections: config.volumeRoofConnections,
    volumeRoofShapes: config.volumeRoofShapes,
    roofHeightMode: config.roofHeightMode,
    ...pickEaveConfig({ ...config, roofEaveDepth }),
  });
  const roof = new THREE.Mesh(roofGeometry, materials.roof);
  roof.position.y = foundationHeight + totalHeight + ROOF_LIFT;
  roofZones.forEach((zone) => {
    zone.baseY = roof.position.y;
    zone.wallTopY = foundationHeight + totalHeight;
    zone.foundationTopY = volumeFoundationHeight(zone.volumeId, levelConfig);
  });
  roof.userData = {
    roofZoneId: primaryRoofZone?.id ?? 'roof-zone-main',
    roofType: resolvedRoofType,
    roofDirection: resolvedRoofDirection,
    roofHeight,
    roofPitch: {
      rise: resolvedRoofPitchRise,
      run: resolvedRoofPitchRun,
      degrees: roofPitchDegrees(resolvedRoofPitchRise, resolvedRoofPitchRun),
    },
  };
  group.add(roof);

  if (config.facadeLayout && getRectangularBounds(footprint)) {
    addFacadePanels(group, footprint, config.facadeLayout, foundationHeight, config);
  }

  group.userData = {
    ...group.userData,
    storyCount,
    storyHeight,
    foundationDepth,
    roofOverhang,
    roofEaveDepth,
    roofType,
    roofDirection,
    roofHeight,
    roofPitchRise,
    roofPitchRun,
    facadePanelsRendered: Boolean(config.facadeLayout && getRectangularBounds(footprint)),
  };

  return withStructuresAndWalks({
    building: group, foundationHeight, totalHeight, roofZones,
  }, config, skeletonWalks.map((walk) => ({ ...walk, y: roof.position.y + walk.height })));
}

/**
 * A volume's walls and foundation, from its floor (`floorY`) up to its wall
 * top (`topY`): a closed solid, or with a walk-in interior on (see
 * js/interior.js) a hollow shell over an open-topped foundation, with its
 * room recorded in `group.userData.interiorRooms` for the doors and the
 * passages between rooms to be cut through. A volume too narrow for a room
 * stays solid, noted in `group.userData.interiorWarnings`. A volume on a
 * slab at grade (a garage) has no foundation wall.
 */
function addVolumeBody(group, volume, {
  floorY, topY, config, materials,
}) {
  const bounds = {
    minX: volume.minX, maxX: volume.maxX, minZ: volume.minZ, maxZ: volume.maxZ,
  };
  const outline = volume.outline ?? [[bounds.minX, bounds.minZ], [bounds.maxX, bounds.minZ], [bounds.maxX, bounds.maxZ], [bounds.minX, bounds.maxZ]];
  const wallMaterial = volumeWallMaterial(volume.id, config, materials);
  const interior = normalizeInterior(config.interior);
  const inset = interior.enabled ? insetOutline(outline, interior.wallThickness) : null;
  if (interior.enabled && !inset) {
    group.userData.interiorWarnings = [...(group.userData.interiorWarnings ?? []), { code: 'interior-too-thin', volumeId: volume.id, message: `${volume.id} is too narrow for a room inside its walls: left solid.` }];
  }
  if (inset) {
    // the room reaches the ground story's ceiling: the first floor line, or just under the wall top of a single story
    const { count, height, hasKneeWall } = volumeStories(volume.id, config);
    const ceilingY = Math.min(count > 1 || hasKneeWall ? floorY + height : topY, topY - CEILING_BAND);
    const shell = shellTriangles({
      outline, inset, floorY, ceilingY, topY,
    });
    const add = (triangles, material, bodyPart) => {
      const mesh = new THREE.Mesh(trianglesToGeometry(triangles), material);
      // wound from the mass into the air, which the game export trusts (see buildGameFile)
      mesh.userData = { volumeId: volume.id, bodyPart, oriented: true };
      group.add(mesh);
    };
    add(shell.outer, wallMaterial, 'walls');
    add(shell.inner, materials.interiorWall, 'interior-wall');
    add(shell.floor, materials.interiorFloor, 'interior-floor');
    add(shell.ceiling, materials.interiorCeiling, 'interior-ceiling');
    if (floorY > 1e-9) {
      // open on top: the room's floor and the wall's underside close it
      const sides = outline.flatMap(([x, z], i) => {
        const [nx, nz] = outline[(i + 1) % outline.length];
        return [[[x, 0, z], [nx, 0, nz], [nx, floorY, nz]], [[x, 0, z], [nx, floorY, nz], [x, floorY, z]]];
      });
      const bottom = outline.slice(1, -1).map((_, k) => [[outline[0][0], 0, outline[0][1]], [outline[k + 1][0], 0, outline[k + 1][1]], [outline[k + 2][0], 0, outline[k + 2][1]]]);
      const foundation = new THREE.Mesh(trianglesToGeometry([...sides, ...bottom]), materials.foundation);
      foundation.userData = { volumeId: volume.id };
      group.add(foundation);
    }
    group.userData.interiorRooms = [...(group.userData.interiorRooms ?? []), {
      volumeId: volume.id, outline, inset, floorY, ceilingY, topY, wallThickness: interior.wallThickness,
    }];
    return;
  }
  const walls = new THREE.Mesh(createBoxWallGeometry(bounds, topY - floorY, volume.outline), wallMaterial);
  walls.position.y = floorY;
  walls.userData = { volumeId: volume.id, bodyPart: 'walls' };
  group.add(walls);
  if (floorY > 1e-9) {
    const foundation = new THREE.Mesh(createBoxWallGeometry(bounds, floorY, volume.outline), materials.foundation);
    foundation.userData = { volumeId: volume.id };
    group.add(foundation);
  }
}

/** The tallest and narrowest a passage between two rooms may be and still be cut. */
const MIN_PASSAGE_HEIGHT = 2;
const MIN_PASSAGE_WIDTH = 0.6;

/**
 * Cuts an aperture (see apertureSolid) out of a room's walls, both skins, and
 * any facade panel over them, and lines the cut with reveals so the wall
 * stays closed. `frame` is the wall's run (start, end, normal, right) and
 * `span` the cut's u0/u1 (from the run's midpoint), y0/y1, and d0/d1.
 */
function cutThroughWall(group, room, frame, span, materials) {
  const solid = apertureSolid(frame, span);
  group.children.filter((mesh) => mesh.isMesh && (
    (mesh.userData?.volumeId === room.volumeId && ['walls', 'interior-wall'].includes(mesh.userData.bodyPart))
    || mesh.userData?.bodyPart === 'facade-panel'
  )).forEach((mesh) => {
    const { x, y, z } = mesh.position;
    const triangles = geometryTriangles(mesh.geometry).map((tri) => tri.map(([px, py, pz]) => [px + x, py + y, pz + z]));
    const kept = clipOutsideConvexSolid(triangles, solid);
    if (kept.length === triangles.length && kept.every((tri, i) => tri.every((p, k) => p.every((v, j) => v === triangles[i][k][j])))) {
      return;
    }
    mesh.geometry.dispose();
    mesh.geometry = trianglesToGeometry(kept.map((tri) => tri.map(([px, py, pz]) => [px - x, py - y, pz - z])));
  });
  const reveals = new THREE.Mesh(trianglesToGeometry(apertureReveals(frame, span, room.wallThickness)), materials.interiorWall);
  reveals.userData = { volumeId: room.volumeId, bodyPart: 'interior-wall', oriented: true };
  group.add(reveals);
}

/**
 * Walk-in rooms of neighboring volumes joined: a passage through each
 * volume's wall on the line they share, as wide as the shared span less a
 * wall's thickness at either end, from the higher floor to the lower
 * ceiling. Where one floor stands higher, the lower room's wall below the
 * passage is its riser. Too low or too narrow a passage is left out, noted
 * in `group.userData.interiorWarnings`.
 */
function cutPassages(group, volumes, materials) {
  const rooms = new Map((group.userData.interiorRooms ?? []).map((room) => [room.volumeId, room]));
  if (rooms.size < 2) {
    return;
  }
  findVolumeAdjacencies(volumes).forEach(({
    volumeAId, sideA, volumeBId, sideB, axis, overlapMin, overlapMax,
  }) => {
    const [a, b] = [rooms.get(volumeAId), rooms.get(volumeBId)];
    if (!a || !b) {
      return;
    }
    const volumeA = volumes.find((volume) => volume.id === volumeAId);
    const line = volumeA[sideA];
    const t = Math.max(a.wallThickness, b.wallThickness);
    const width = overlapMax - overlapMin - 2 * t;
    const y0 = Math.max(a.floorY, b.floorY);
    const y1 = Math.min(a.ceilingY, b.ceilingY);
    if (width < MIN_PASSAGE_WIDTH || y1 - y0 < MIN_PASSAGE_HEIGHT) {
      group.userData.interiorWarnings = [...(group.userData.interiorWarnings ?? []), {
        code: 'passage-too-small', volumeIds: [volumeAId, volumeBId], message: `No way through between ${volumeAId} and ${volumeBId}: too ${width < MIN_PASSAGE_WIDTH ? 'narrow' : 'low'} a passage.`,
      }];
      return;
    }
    const [start, end] = axis === 'z' ? [[line, overlapMin], [line, overlapMax]] : [[overlapMin, line], [overlapMax, line]];
    const right = axis === 'z' ? [0, 1] : [1, 0];
    const half = (overlapMax - overlapMin) / 2;
    const outward = (side) => ({
      minX: [-1, 0], maxX: [1, 0], minZ: [0, -1], maxZ: [0, 1],
    })[side];
    [[a, sideA], [b, sideB]].forEach(([room, side]) => {
      cutThroughWall(group, room, {
        start, end, normal: outward(side), right,
      }, {
        u0: -half + t, u1: half - t, y0, y1, d0: -room.wallThickness, d1: 0.01,
      }, materials);
    });
  });
}

/**
 * Where a door in a house wall is cut through into a walk-in room: the room
 * it opens into (the one its middle, half a wall in from the face, stands
 * in: a wall can run along more than one volume) and the cut's span. Null
 * without walk-in rooms; a warning instead where the door can't be cut: taller
 * than the room's ceiling, or running into the corner past the room's width.
 */
function doorCut(group, resolved, host) {
  const rooms = group.userData.interiorRooms ?? [];
  if (!rooms.length) {
    return null;
  }
  const { start, end, normal, right } = resolved.frame;
  const mid = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
  const along = (resolved.u0 + resolved.u1) / 2;
  const inside = (outline, [x, z]) => {
    const turn = Math.sign(outline.reduce((sum, [ax, az], i) => {
      const [bx, bz] = outline[(i + 1) % outline.length];
      return sum + ax * bz - bx * az;
    }, 0));
    return outline.every(([ax, az], i) => {
      const [bx, bz] = outline[(i + 1) % outline.length];
      return turn * ((bx - ax) * (z - az) - (bz - az) * (x - ax)) >= -1e-9;
    });
  };
  const room = rooms.find((candidate) => {
    const d = candidate.wallThickness / 2;
    return inside(candidate.outline, [mid[0] + right[0] * along - normal[0] * d, mid[1] + right[1] * along - normal[1] * d]);
  });
  if (!room) {
    return null;
  }
  const y0 = host.baseY + resolved.v0;
  const y1 = host.baseY + resolved.v1;
  const across = room.inset.map(([x, z]) => (x - mid[0]) * right[0] + (z - mid[1]) * right[1]);
  const warning = (why) => ({ warning: { code: 'door-not-cut', message: `not cut through into the room: ${why}` } });
  if (y1 > room.ceilingY - 1e-6) {
    return warning('taller than the room\'s ceiling');
  }
  if (resolved.u0 < Math.min(...across) - 1e-6 || resolved.u1 > Math.max(...across) + 1e-6) {
    return warning('it runs into the corner, past the room\'s width');
  }
  // the doorway is its leaves' part (its sidelights and transom stay glazed on the wall)
  const leaf = leafSpan(resolved);
  return {
    room,
    span: {
      u0: leaf.u0, u1: leaf.u1, y0, y1: host.baseY + leaf.v1, d0: -room.wallThickness, d1: 0.2,
    },
  };
}

/** A volume's wall material: its own (`volumeMaterials`), or the building's. */
function volumeWallMaterial(volumeId, config, materials) {
  const key = config.volumeMaterials?.[volumeId];
  return MATERIAL_PALETTE[key] ? paletteMaterial(key, 'wall') : materials.wall;
}

/** How far a window/door's whole appliqué (frame + pane) sits proud of the wall face, to avoid z-fighting. */
const OPENING_OUTWARD_NUDGE = 0.01;

/**
 * A window or door's meshes: a thin frame ring (a THREE.Shape with the
 * opening as its hole, extruded FRAME_DEPTH) plus a recessed pane (glazing
 * for a window, an opaque panel for a door) — additive appliqué geometry on
 * the wall's outer face, not a cut through it (see js/openings.js's doc
 * comment for why). Built in the wall's own (u, v, depth) frame, then
 * oriented into world space.
 */
function buildOpeningMeshes(resolved, materials, glazing, flight = null, { open = false } = {}) {
  const { outer, inner } = openingOutline(resolved);
  const frameShape = new THREE.Shape(outer.map(([u, v]) => new THREE.Vector2(u, v)));
  frameShape.holes.push(new THREE.Path(inner.map(([u, v]) => new THREE.Vector2(u, v))));
  const frameGeometry = new THREE.ExtrudeGeometry(frameShape, {
    depth: FRAME_DEPTH, bevelEnabled: false, steps: 1, curveSegments: 1,
  });
  // Oriented below by a rotation.y that maps local +X to the wall's own
  // "right" direction (needed to place an off-center opening on the correct
  // side) — a wall's (right, worldUp, outward-normal) is a left-handed
  // triple, so that same rotation necessarily maps local +Z to the *inward*
  // direction, not outward. Shifting the extrusion to [-FRAME_DEPTH, 0]
  // compensates: 0 stays at the wall face, and increasingly negative local Z
  // (mapped to increasingly outward world space) is where the frame projects.
  frameGeometry.translate(0, 0, -FRAME_DEPTH);
  const frameMaterial = resolved.materials.frame ? paletteMaterial(resolved.materials.frame, 'wall') : materials.wall;
  const frameMesh = new THREE.Mesh(frameGeometry, frameMaterial);
  frameMesh.userData = { openingId: resolved.id, bodyPart: 'opening-frame' };

  // its glass and door panels, and its details (see js/opening-details.js), in the
  // same frame: u along x, v up, and out from the wall along -z
  const { boxes, panes } = detailParts(resolved, { open });
  const partMaterials = {
    frame: frameMaterial,
    shutter: paletteMaterial(resolved.materials.shutter ?? 'black', 'wall'),
    glass: glazing,
    panel: paletteMaterial(resolved.materials.panel ?? 'wood', 'door'),
  };
  const group = new THREE.Group();
  group.add(frameMesh);
  panes.forEach(({ points, material }) => {
    const paneMesh = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(points.map(([u, v]) => new THREE.Vector2(u, v)))), partMaterials[material]);
    paneMesh.position.z = -(FRAME_DEPTH - PANE_RECESS);
    paneMesh.userData = { openingId: resolved.id, bodyPart: 'opening-pane' };
    group.add(paneMesh);
  });
  ['frame', 'shutter'].forEach((material) => {
    const geometries = boxes.filter((part) => part.material === material).map((part) => {
      const geometry = new THREE.BoxGeometry(part.u1 - part.u0, part.v1 - part.v0, part.d1 - part.d0);
      geometry.translate((part.u0 + part.u1) / 2, (part.v0 + part.v1) / 2, -(part.d0 + part.d1) / 2);
      return geometry;
    });
    if (geometries.length) {
      const mesh = new THREE.Mesh(mergeFlatGeometries(geometries), partMaterials[material]);
      mesh.userData = { openingId: resolved.id, bodyPart: 'opening-detail' };
      group.add(mesh);
    }
  });
  if (flight) {
    group.add(buildDoorSteps(resolved, flight, materials.foundation));
  }

  const {
    start, end, normal, baseY, right,
  } = resolved.frame;
  const [dirX, dirZ] = right;
  group.rotation.y = Math.atan2(-dirZ, dirX);
  group.position.set(
    (start[0] + end[0]) / 2 + normal[0] * OPENING_OUTWARD_NUDGE,
    baseY,
    (start[1] + end[1]) / 2 + normal[1] * OPENING_OUTWARD_NUDGE
  );
  group.userData = { openingId: resolved.id, bodyPart: 'opening' };
  return group;
}

/** Whether a door's steps would run into a structure standing in front of it (a porch's floor, a bay). */
function doorStepPlans(resolved, flight) {
  const { start, end, normal } = resolved.frame;
  const mid = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
  const right = [(end[0] - start[0]), (end[1] - start[1])].map((c) => c / Math.hypot(end[0] - start[0], end[1] - start[1]));
  const center = (resolved.u0 + resolved.u1) / 2;
  return flight.pieces.map(({
    profile, at, toward, width,
  }) => {
    const out = Math.max(...profile.map(([o]) => o));
    const across = [toward[1], -toward[0]];
    // (the strip along the wall itself doesn't count: the steps stand against it)
    const corners = [[0, 0], [out, 0], [out, width], [0, width]].map(([o, w]) => [at[0] + toward[0] * o + across[0] * w, Math.max(0.02, at[1] + toward[1] * o + across[1] * w)])
      .map(([u, d]) => [mid[0] + right[0] * (center + u) + normal[0] * d, mid[1] + right[1] * (center + u) + normal[1] * d]);
    const xs = corners.map(([x]) => x);
    const zs = corners.map(([, z]) => z);
    return {
      minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs),
    };
  });
}

/** Whether two plan rectangles overlap (more than touching). */
function plansOverlap(a, b) {
  const gap = 1e-3;
  return a.minX < b.maxX - gap && a.maxX > b.minX + gap && a.minZ < b.maxZ - gap && a.maxZ > b.minZ + gap;
}

/**
 * Why a door's steps can't be built where they'd stand, or null: a structure
 * standing in front of the door (a porch's floor, a bay), the house itself
 * (a flight run along the wall into an inside corner), or another flight of
 * steps already there.
 */
function doorStepsConflict(resolved, flight, { structures, masses, steps }) {
  const plans = doorStepPlans(resolved, flight);
  const hits = (list) => plans.some((plan) => list.some((other) => plansOverlap(plan, other)));
  if (hits(structures)) {
    return 'steps left off: a porch or other structure stands in front of the door';
  }
  if (hits(masses)) {
    return 'steps left off: they would run into the house';
  }
  if (hits(steps)) {
    return 'steps left off: they would run into another flight of steps';
  }
  return null;
}

/** Porch steps are this wide unless set otherwise, and never wider than the porch's open front. */
export const PORCH_STEP_WIDTH = 1.5;

/**
 * Steps from each ground-level porch's deck (a porch standing on a solid deck
 * or on posts on one) down to grade, centered on its open front: the deck is
 * the top step, so the flight starts a riser below it (stepFlight with no
 * landing).
 */
function withPorchSteps(result, config) {
  const facades = new Map((result.structureFacades ?? []).map((facade) => [facade.structureId, facade]));
  const material = createMaterials(config).foundation;
  (result.roofStructures ?? []).forEach(({ resolved }) => {
    const opening = resolved && porchStepOpening(resolved);
    if (!opening) {
      return;
    }
    const center = opening.point((opening.from + opening.to) / 2);
    const normal = PORCH_OUTWARD[opening.side];
    result.building.add(buildStepsAt(center, normal, opening.width, opening.flight, material, { structureId: resolved.id, bodyPart: 'porch-steps' }));
    const corners = [opening.point(opening.from), opening.point(opening.to)].flatMap(([x, z]) => [[x, z], [x + normal[0] * opening.flight.depth, z + normal[1] * opening.flight.depth]]);
    result.stepPlans = [...(result.stepPlans ?? []), {
      minX: Math.min(...corners.map(([x]) => x)), maxX: Math.max(...corners.map(([x]) => x)), minZ: Math.min(...corners.map(([, z]) => z)), maxZ: Math.max(...corners.map(([, z]) => z)),
    }];
    // railings down both sides of the flight, from the deck's edge (a post frames each side there)
    const steps = normalizeSteps(resolved.steps);
    if (steps.railings.enabled) {
      const { flight } = opening;
      result.stairRails = result.stairRails ?? [];
      [opening.from + STEP_RAIL_INSET, opening.to - STEP_RAIL_INSET].forEach((t, i) => {
        const [x, z] = opening.point(t);
        result.stairRails.push({
          run: { id: `${resolved.id}-stair-rail-${i}`, start: [x, resolved.sillY, z], end: [x + normal[0] * flight.depth, flight.riser, z + normal[1] * flight.depth] },
          settings: steps.railings,
          stair: true,
          top: false,
        });
      });
    }
    // the front railing opens where the steps come up
    const front = (facades.get(resolved.id)?.railRuns ?? []).filter((run) => run.wall === 'front')
      .find((run) => {
        const along = (p) => opening.alongOf([p[0], p[2]]);
        const [lo, hi] = [along(run.start), along(run.end)].sort((x, y) => x - y);
        return lo <= opening.from + 1e-6 && hi >= opening.to - 1e-6;
      });
    if (front) {
      const dir = Math.sign(opening.alongOf([front.end[0], front.end[2]]) - opening.alongOf([front.start[0], front.start[2]])) || 1;
      const u = (t) => (t - opening.alongOf([front.start[0], front.start[2]])) * dir;
      result.railGaps = result.railGaps ?? new Map();
      result.railGaps.set(front.id, [[Math.min(u(opening.from), u(opening.to)), Math.max(u(opening.from), u(opening.to))]]);
    }
  });
  return result;
}

/**
 * Where a ground-level porch's steps come up its open front, if it has them
 * (a porch on a deck, or on posts on one, open at the front, with steps on):
 * `side` (of the porch's rectangle), `from`/`to` along that side's axis (the
 * opening, as wide as the steps, centered on the side), the `flight`, and
 * helpers from a plan point to its position along the side (`alongOf`) and
 * back (`point`). The porch's posts frame this opening, the steps fill it,
 * and its railing opens across it.
 */
function porchStepOpening(resolved) {
  if (resolved.kind !== 'porch' || resolved.hood || !['deck', 'porch'].includes(resolved.support) || !resolved.openSides.includes('front')) {
    return null;
  }
  const steps = normalizeSteps(resolved.steps);
  const flight = steps.enabled && flightFor(steps, resolved.sillY, { deck: true });
  if (!flight) {
    return null;
  }
  const side = structureWallSides(resolved.frame).front;
  const { bounds } = resolved;
  const k = side === 'minX' || side === 'maxX' ? 1 : 0;
  const [a, b] = k === 1 ? [bounds.minZ, bounds.maxZ] : [bounds.minX, bounds.maxX];
  const width = Math.min(steps.width ?? PORCH_STEP_WIDTH, b - a - 0.2);
  if (width < 0.6) {
    return null;
  }
  // moved along the front (to the right as seen from outside), kept within it
  const [nx, nz] = PORCH_OUTWARD[side];
  const rightward = Math.sign([nz, -nx][k]);
  const travel = porchStepTravel(b - a, width);
  const mid = (a + b) / 2 + rightward * Math.min(Math.max(steps.offset, -travel), travel);
  return {
    side,
    flight,
    width,
    from: mid - width / 2,
    to: mid + width / 2,
    alongOf: (point) => point[k],
    point: (t) => (k === 1 ? [bounds[side], t] : [t, bounds[side]]),
  };
}

const PORCH_OUTWARD = { minX: [-1, 0], maxX: [1, 0], minZ: [0, -1], maxZ: [0, 1] };

/** Where posts (plan rectangles) stand across a railing run's line, as [from, to] along it. */
function postSpans(run, rects) {
  const [dx, dz] = [run.end[0] - run.start[0], run.end[2] - run.start[2]];
  const length = Math.hypot(dx, dz);
  const along = [dx / length, dz / length];
  const across = [-along[1], along[0]];
  const eps = 1e-6;
  return rects.flatMap((rect) => {
    const corners = [[rect.minX, rect.minZ], [rect.maxX, rect.minZ], [rect.maxX, rect.maxZ], [rect.minX, rect.maxZ]]
      .map(([x, z]) => [(x - run.start[0]) * along[0] + (z - run.start[2]) * along[1], (x - run.start[0]) * across[0] + (z - run.start[2]) * across[1]]);
    const cs = corners.map(([, c]) => c);
    if (Math.min(...cs) > eps || Math.max(...cs) < -eps) {
      return [];
    }
    const us = corners.map(([u]) => u);
    return Math.max(...us) < -eps || Math.min(...us) > length + eps ? [] : [[Math.min(...us), Math.max(...us)]];
  });
}

/**
 * Railings (js/railings.js) along every porch's open sides and every widow's
 * walk's edges, in the building's trim material: a porch's as its record
 * sets them (`railings`, no higher than its ceiling), on its posts' center
 * line and stopping at their faces, opening at its steps with newels either
 * side; a walk's as
 * the building sets them (`walkRailings`), with newels at its ends.
 */
function addRailings(result, config, roofWalks) {
  const records = new Map((config.roofStructures ?? []).map((record) => [record.id, record]));
  const resolvedById = new Map((result.roofStructures ?? []).filter((entry) => entry.resolved).map((entry) => [entry.resolved.id, entry.resolved]));
  const runs = [];
  (result.structureFacades ?? []).forEach((facade) => {
    const resolved = resolvedById.get(facade.structureId);
    const settings = normalizeRailing(records.get(resolved?.recordId ?? facade.structureId)?.railings);
    if (!resolved || !settings.enabled) {
      return;
    }
    const height = Math.min(settings.height, resolved.plateY - resolved.sillY);
    const postRects = openSidePostPoints(resolved, []).map((point) => postRect(resolved.bounds, point));
    facade.railRuns.forEach((edge) => {
      // on the posts' center line: they stand inside the porch, flush with its side
      const [ox, oz] = PORCH_OUTWARD[edge.side].map((c) => -c * (POST_SIZE / 2));
      const run = {
        ...edge, start: [edge.start[0] + ox, edge.start[1], edge.start[2] + oz], end: [edge.end[0] + ox, edge.end[1], edge.end[2] + oz],
      };
      runs.push({
        run, settings, height, posts: false, obstacles: postSpans(run, postRects),
      });
    });
  });
  const walkSettings = normalizeRailing(config.walkRailings);
  if (walkSettings.enabled) {
    roofWalks.flatMap((walk) => walk.railRuns ?? []).forEach((run) => runs.push({
      run, settings: walkSettings, height: walkSettings.height, posts: true, obstacles: [],
    }));
  }
  (result.stairRails ?? []).forEach(({
    run, settings, stair, top = true,
  }) => {
    const length = Math.hypot(run.end[0] - run.start[0], run.end[2] - run.start[2]);
    runs.push({
      run, settings, height: settings.height, posts: stair ? [...(top ? [0] : []), length] : false, obstacles: [], drop: run.start[1] - run.end[1],
    });
  });
  const triangles = [];
  runs.forEach(({
    run, settings, height, posts, obstacles, drop = 0,
  }) => {
    const [dx, dz] = [run.end[0] - run.start[0], run.end[2] - run.start[2]];
    const length = Math.hypot(dx, dz);
    if (length < 1e-6 || !(height > TOP_RAIL.height)) {
      return;
    }
    const along = [dx / length, dz / length];
    const across = [-along[1], along[0]];
    const toWorld = ([u, c, y]) => [run.start[0] + along[0] * u + across[0] * c, run.start[1] + y, run.start[2] + along[1] * u + across[1] * c];
    railingParts(length, settings, {
      height, gaps: result.railGaps?.get(run.id) ?? [], posts: Array.isArray(posts) ? posts : (posts ? [0, length] : []), obstacles, drop,
    })
      .forEach((part) => partTriangles(part).forEach((triangle) => triangles.push(triangle.map(toWorld))));
  });
  if (triangles.length) {
    const mesh = new THREE.Mesh(trianglesToGeometry(triangles), paletteMaterial(normalizeTrim(config.trim).material, 'trim'));
    mesh.userData = { bodyPart: 'railing' };
    result.building.add(mesh);
  }
}

/**
 * A flight of steps in world space: its profile's "out" along `normal` (in
 * plan) from `center` on the edge it climbs to, its foot at grade, swept
 * `width` across.
 */
function buildStepsAt(center, [nx, nz], width, flight, material, userData) {
  const shape = new THREE.Shape(flight.profile.map(([out, up]) => new THREE.Vector2(out, up)));
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: width, bevelEnabled: false, steps: 1, curveSegments: 1,
  });
  // shape x (out) -> the normal, shape y -> up, extrusion -> along the edge (normal x up, so a proper rotation)
  const [ax, az] = [-nz, nx];
  geometry.applyMatrix4(new THREE.Matrix4().set(
    nx, 0, ax, center[0] - ax * (width / 2),
    0, 1, 0, 0,
    nz, 0, az, center[1] - az * (width / 2),
    0, 0, 0, 1
  ));
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData = userData;
  return mesh;
}

/**
 * A door's entry steps (see stepFlight in js/openings.js), in the door's own
 * frame: the flight's side profile, extruded across the door's width plus a
 * margin each side, turned so its "out" runs from the wall face outward (the
 * frame's local -Z, see buildOpeningMeshes) and its foot sits at grade.
 */
function buildDoorSteps(resolved, flight, material) {
  const center = (resolved.u0 + resolved.u1) / 2;
  const geometries = flight.pieces.map(({
    profile, at, toward, width,
  }) => {
    const shape = new THREE.Shape(profile.map(([out, up]) => new THREE.Vector2(out, up)));
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: width, bevelEnabled: false, steps: 1, curveSegments: 1,
    });
    // shape x (out) along `toward`, shape y up, extrusion across [toward.d, -toward.u]; (u, d) is local (x, -z)
    const [tu, td] = toward;
    const [su, sd] = [td, -tu];
    geometry.applyMatrix4(new THREE.Matrix4().set(
      tu, 0, su, center + at[0],
      0, 1, 0, -resolved.frame.baseY,
      -td, 0, -sd, -at[1] + OPENING_OUTWARD_NUDGE,
      0, 0, 0, 1
    ));
    return geometry;
  });
  const mesh = new THREE.Mesh(mergeFlatGeometries(geometries), material);
  mesh.userData = { openingId: resolved.id, bodyPart: 'opening-steps' };
  return mesh;
}

/**
 * Adds windows and doors (config.openings) to a built building, each
 * appliquéd onto its host: a footprint wall run, or a roof structure's own wall (from this build's structure facades) — see js/openings.js. Mirrors
 * withRoofStructures' own shape: returns `{ ...result, openings: entries }`,
 * one entry per opening (built or not) so main.js can track build errors the
 * same way it already does for roof structures.
 */
function withOpenings(result, config) {
  const openings = config.openings ?? [];
  if (openings.length === 0) {
    return { ...result, openings: [] };
  }
  const wallRuns = config.facadeLayout?.wallRuns ?? [];
  const { stories } = config.facadeLayout ?? {};
  const materials = createMaterials(config);
  const glazing = glazingMaterial();
  const structureWalls = (result.structureFacades ?? []).flatMap((facade) => facade.wallRuns);
  const standingPlans = (result.roofStructures ?? []).filter((entry) => entry.resolved?.standing).map((entry) => entry.resolved.bounds);
  const massPlans = (config.volumes ?? []).map(({
    id, minX, maxX, minZ, maxZ,
  }) => ({
    id, minX, maxX, minZ, maxZ,
  }));
  // flights already placed (a porch's, then each door's in turn)
  const stepPlans = [...(result.stepPlans ?? [])];
  const entries = openings.map((opening) => {
    const wallRun = wallRuns.find((run) => run.id === opening.hostWallRunId);
    const structureWall = !wallRun && structureWalls.find((run) => run.id === opening.hostWallRunId);
    const host = wallRun ? {
      ...wallRun,
      wallHeight: volumeWallHeight(wallRun.volumeId, config),
      baseY: volumeFoundationHeight(wallRun.volumeId, config),
    } : structureWall && structureOpeningHost(structureWall);
    const { resolved, errors, warnings } = resolveOpening(opening, host, { siblings: openings, stories });
    if (resolved) {
      // steps down to grade from a door in the house's own walls (a door on a
      // structure's wall opens onto its floor or roof), unless a porch or bay
      // stands in front of it
      const steps = normalizeSteps(opening.steps);
      const width = steps.width ?? (resolved.u1 - resolved.u0) + 2 * (FRAME_CASING_WIDTH + STEP_SIDE_MARGIN);
      const doorFlight = opening.kind === 'door' && steps.enabled && wallRun ? doorStepPieces(steps, host.baseY + resolved.sillHeight, width) : null;
      // (the door's own mass is behind it: an angled wall's mass reaches past it in plan)
      const masses = massPlans.filter((mass) => mass.id !== wallRun?.volumeId);
      const conflict = doorFlight && doorStepsConflict(resolved, doorFlight, { structures: standingPlans, masses, steps: stepPlans });
      if (conflict) {
        warnings.push({ code: 'steps-left-off', message: conflict });
      }
      const flight = doorFlight && !conflict ? doorFlight : null;
      if (flight) {
        stepPlans.push(...doorStepPlans(resolved, flight));
      }
      // a frame left to default takes its wall's material: its own volume's, where that differs
      const wallMaterial = wallRun ? volumeWallMaterial(wallRun.volumeId, config, materials) : materials.wall;
      // a door in a walk-in room's wall is cut through it, and stands open
      const cut = opening.kind === 'door' && wallRun ? doorCut(result.building, resolved, host) : null;
      if (cut?.room) {
        cutThroughWall(result.building, cut.room, resolved.frame, cut.span, materials);
        const panel = paletteMaterial(resolved.materials.panel ?? 'wood', 'door');
        // a pair stands open about both jambs, a single leaf about its hinge
        const { span } = cut;
        const middle = (span.u0 + span.u1) / 2;
        const leaves = normalizeDetails('door', resolved.details).leaves === 2
          ? [[{ ...span, u1: middle }, 'right'], [{ ...span, u0: middle }, 'left']]
          : [[span, opening.hinge]];
        leaves.forEach(([leafSpanned, hinge]) => {
          const leaf = new THREE.Mesh(trianglesToGeometry(doorLeaf(resolved.frame, leafSpanned, cut.room.wallThickness, hinge)), panel);
          leaf.userData = { openingId: resolved.id, bodyPart: 'door-leaf', collides: false, oriented: true };
          result.building.add(leaf);
        });
      } else if (cut?.warning) {
        warnings.push(cut.warning);
      }
      result.building.add(buildOpeningMeshes(resolved, { ...materials, wall: wallMaterial }, glazing, flight, { open: Boolean(cut?.room) }));
      if (flight && steps.railings.enabled) {
        // the door's frame to world: u across the wall from the door's center, d out from it
        const { start, end, normal } = resolved.frame;
        const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
        const right = [(end[0] - start[0]) / length, (end[1] - start[1]) / length];
        const center = (start[0] + end[0]) / 2 + right[0] * (resolved.u0 + resolved.u1) / 2;
        const centerZ = (start[1] + end[1]) / 2 + right[1] * (resolved.u0 + resolved.u1) / 2;
        const world = ([u, y, d]) => [center + right[0] * u + normal[0] * d, y, centerZ + right[1] * u + normal[1] * d];
        result.stairRails = result.stairRails ?? [];
        doorStepRails(steps, host.baseY + resolved.sillHeight, width, flight).forEach((rail, i) => result.stairRails.push({
          run: { id: `${opening.id}-stair-rail-${i}`, start: world(rail.start), end: world(rail.end) }, settings: steps.railings, stair: rail.stair,
        }));
      }
    }
    return {
      id: opening.id, opening, host, resolved, errors, warnings,
    };
  });
  return { ...result, openings: entries };
}

/** How far outside a wall face the cornice looks up for the soffit above it. */
const SOFFIT_PROBE_OFFSET = 0.03;
/** Clearance left between a cornice's top and the soffit, so the two don't z-fight. */
const CORNICE_SOFFIT_GAP = 0.003;

/** The building's own roof triangles (not its structures'), in the building's frame. */
function mainRoofTriangles(building) {
  const triangles = [];
  const v = new THREE.Vector3();
  building.children.filter((child) => child.isMesh && child.userData?.roofType).forEach((roof) => {
    roof.updateMatrix();
    const position = roof.geometry.getAttribute('position');
    const index = roof.geometry.index;
    const count = index ? index.count : position.count;
    const point = (i) => {
      v.fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(roof.matrix);
      return [v.x, v.y, v.z];
    };
    for (let i = 0; i + 2 < count; i += 3) {
      triangles.push([point(i), point(i + 1), point(i + 2)]);
    }
  });
  return triangles;
}

/** The lowest roof surface straight above (x, z) that is higher than `floorY`, or Infinity. */
function lowestSurfaceAbove(triangles, x, z, floorY) {
  let best = Infinity;
  triangles.forEach(([a, b, c]) => {
    const det = (b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2]);
    if (Math.abs(det) < 1e-12) {
      return;
    }
    const l1 = ((x - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (z - a[2])) / det;
    const l2 = ((b[0] - a[0]) * (z - a[2]) - (x - a[0]) * (b[2] - a[2])) / det;
    if (l1 < -1e-9 || l2 < -1e-9 || l1 + l2 > 1 + 1e-9) {
      return;
    }
    const y = a[1] + l1 * (b[1] - a[1]) + l2 * (c[1] - a[1]);
    if (y > floorY && y < best) {
      best = y;
    }
  });
  return best;
}

/** The highest roof surface straight above (x, z), or -Infinity where there's none. */
function highestSurfaceAt(triangles, x, z) {
  let best = -Infinity;
  triangles.forEach(([a, b, c]) => {
    const det = (b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2]);
    if (Math.abs(det) < 1e-12) {
      return;
    }
    const l1 = ((x - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (z - a[2])) / det;
    const l2 = ((b[0] - a[0]) * (z - a[2]) - (x - a[0]) * (b[2] - a[2])) / det;
    if (l1 < -1e-9 || l2 < -1e-9 || l1 + l2 > 1 + 1e-9) {
      return;
    }
    best = Math.max(best, a[1] + l1 * (b[1] - a[1]) + l2 * (c[1] - a[1]));
  });
  return best;
}

/**
 * The chimneys (config.chimneys, see js/chimneys.js) on the house's own
 * walls: each from the ground (outside) or its volume's wall top (inside)
 * up `aboveRoof` over the highest roof within CHIMNEY_REACH of it, found on
 * the built roof (sampled over a grid round the chimney), and never lower
 * than that over the wall top. A chimney whose wall isn't there is noted in
 * `result.chimneys`.
 */
function withChimneys(result, config) {
  const chimneys = normalizeChimneys(config.chimneys);
  if (!chimneys.length) {
    return { ...result, chimneys: [] };
  }
  const wallRuns = config.facadeLayout?.wallRuns ?? [];
  const levelConfig = { ...config, foundationDepth: config.foundationDepth ?? 0.6 };
  const roof = mainRoofTriangles(result.building);
  const entries = chimneys.map((chimney) => {
    const run = wallRuns.find((candidate) => candidate.id === chimney.hostWallRunId);
    if (!run) {
      return { id: chimney.id, chimney, errors: [{ code: 'no-host', message: "its wall doesn't exist" }] };
    }
    const plateY = volumeFoundationHeight(run.volumeId, levelConfig) + volumeWallHeight(run.volumeId, config);
    const plan = chimneyPlan(chimney, run);
    const xs = plan.map(([x]) => x);
    const zs = plan.map(([, z]) => z);
    const [minX, maxX, minZ, maxZ] = [Math.min(...xs) - CHIMNEY_REACH, Math.max(...xs) + CHIMNEY_REACH, Math.min(...zs) - CHIMNEY_REACH, Math.max(...zs) + CHIMNEY_REACH];
    let roofTop = plateY;
    const steps = 12;
    for (let i = 0; i <= steps; i += 1) {
      for (let j = 0; j <= steps; j += 1) {
        roofTop = Math.max(roofTop, highestSurfaceAt(roof, minX + ((maxX - minX) * i) / steps, minZ + ((maxZ - minZ) * j) / steps));
      }
    }
    const bottom = chimney.position === 'inside' ? plateY : 0;
    const triangles = chimneyParts(plan, bottom, roofTop + chimney.aboveRoof).flatMap(chimneyPartTriangles);
    const mesh = new THREE.Mesh(trianglesToGeometry(triangles), paletteMaterial(chimney.material, 'wall'));
    mesh.userData = { chimneyId: chimney.id, bodyPart: 'chimney' };
    result.building.add(mesh);
    return {
      id: chimney.id, chimney, errors: [], top: roofTop + chimney.aboveRoof,
    };
  });
  return { ...result, chimneys: entries };
}

/** A volume's stories, as volumeWallHeight counts them. */
export function volumeStories(volumeId, config) {
  const count = (volumeId && config.volumeStoryOverrides?.[volumeId]) ?? config.storyCount ?? 1;
  const own = volumeId ? config.volumeStoryHeights?.[volumeId] : undefined;
  const height = own > 0 ? own : config.storyHeight ?? 3.2;
  const ownKnee = volumeId ? config.volumeKneeWalls?.[volumeId] : undefined;
  const knee = Number.isFinite(ownKnee) ? ownKnee : config.kneeWallHeight;
  return { count, height, hasKneeWall: knee > 0 };
}

/**
 * Where a cornice's top sits on each footprint wall run: just under the
 * soffit (measured from the built roof, straight up from just outside the
 * wall, so every roof type and eave style is followed as built), level all
 * the way round among the runs that share a plate, and at the plate where
 * nothing overhangs the wall.
 */
function corniceTops(runs, building) {
  const triangles = mainRoofTriangles(building);
  const measured = runs.map((run) => {
    let lowest = Infinity;
    [0.15, 0.5, 0.85].forEach((t) => {
      const x = run.start[0] + (run.end[0] - run.start[0]) * t + run.normal[0] * SOFFIT_PROBE_OFFSET;
      const z = run.start[1] + (run.end[1] - run.start[1]) * t + run.normal[1] * SOFFIT_PROBE_OFFSET;
      lowest = Math.min(lowest, lowestSurfaceAbove(triangles, x, z, run.baseY + run.wallHeight * 0.5));
    });
    return lowest;
  });
  const plateKey = (run) => run.plateY.toFixed(4);
  const byPlate = new Map();
  runs.forEach((run, i) => byPlate.set(plateKey(run), Math.min(byPlate.get(plateKey(run)) ?? Infinity, measured[i])));
  return runs.map((run) => Math.min(run.plateY, byPlate.get(plateKey(run)) - CORNICE_SOFFIT_GAP));
}

/**
 * The parts of a wall run a course spanning [minY, maxY] (world heights)
 * keeps once the run's windows and doors (their frames included) are taken
 * out of it, as [from, to] meters from the run's start.
 */
function coursePieces(run, openingRects, minY, maxY) {
  const cuts = openingRects
    .filter((rect) => rect.minY < maxY - 1e-6 && rect.maxY > minY + 1e-6)
    .map((rect) => [rect.from - 0.01, rect.to + 0.01]);
  if (run.shape) {
    // a structure's wall shows only in part: keep the course where it shows across its whole height
    const hidden = subtractIntervals(run.length, bandIntervals(run.shape, minY - run.baseY, maxY - run.baseY), 0);
    cuts.push(...hidden);
  }
  return subtractIntervals(run.length, cuts);
}

/**
 * Where a wall's visible shape (triangles in (u, v)) spans the whole band
 * from v0 to v1: the u ranges where a line just inside the band's bottom,
 * middle, and top all cross it.
 */
function bandIntervals(shape, v0, v1) {
  const inset = Math.min(1e-4, (v1 - v0) / 4);
  const lineAt = (v) => {
    const spans = shape.flatMap((triangle) => {
      const us = [];
      triangle.forEach((a, i) => {
        const b = triangle[(i + 1) % 3];
        if ((a[1] - v) * (b[1] - v) <= 0 && Math.abs(b[1] - a[1]) > 1e-12) {
          us.push(a[0] + ((v - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
        }
      });
      return us.length >= 2 ? [[Math.min(...us), Math.max(...us)]] : [];
    }).sort((p, q) => p[0] - q[0]);
    const merged = [];
    spans.forEach(([a, b]) => {
      if (merged.length && a <= merged[merged.length - 1][1] + 1e-6) {
        merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], b);
      } else {
        merged.push([a, b]);
      }
    });
    return merged;
  };
  const intersect = (xs, ys) => xs.flatMap(([a, b]) => ys.map(([c, d]) => [Math.max(a, c), Math.min(b, d)]).filter(([p, q]) => q - p > 1e-9));
  return [v0 + inset, (v0 + v1) / 2, v1 - inset].map(lineAt).reduce(intersect);
}

/**
 * Adds the building's trim courses (config.trim, see js/trim.js) along its
 * footprint wall runs: a water table on the foundation, a belt course at each
 * floor line, and a cornice (with dentils) under the eaves. Courses break
 * around windows and doors. Structure walls (porches, dormers, towers) carry
 * none yet.
 */
function withTrim(result, config) {
  const trim = normalizeTrim(config.trim);
  const wallTrim = normalizeWallTrim(config.wallTrim);
  const wallRuns = config.facadeLayout?.wallRuns ?? [];
  // a course runs where the building has it on, or where a wall turns it on for itself
  const anyOn = (kind) => trim[kind].enabled || Object.values(wallTrim).some((own) => own[kind] === 'on');
  if ((!TRIM_KINDS.some(anyOn) && trim.corners.style === 'none' && !trim.gutters.enabled) || wallRuns.length < 3) {
    return result;
  }
  const levelConfig = { ...config, foundationDepth: config.foundationDepth ?? 0.6 };
  const houseRuns = wallRuns.map((wallRun) => {
    const baseY = volumeFoundationHeight(wallRun.volumeId, levelConfig);
    const wallHeight = volumeWallHeight(wallRun.volumeId, config);
    const { count, height, hasKneeWall } = volumeStories(wallRun.volumeId, config);
    return {
      id: wallRun.id,
      start: wallRun.start,
      end: wallRun.end,
      normal: wallRun.normal,
      length: Math.hypot(wallRun.end[0] - wallRun.start[0], wallRun.end[1] - wallRun.start[1]),
      baseY,
      wallHeight,
      plateY: baseY + wallHeight,
      // no foundation (a slab at grade), no water table
      waterY: baseY > 0.01 ? baseY : null,
      floorLines: floorLines(count, height, hasKneeWall).map((line) => baseY + line),
    };
  });
  const tops = corniceTops(houseRuns, result.building);
  houseRuns.forEach((run, i) => {
    run.corniceY = tops[i];
  });
  const chains = [houseRuns, ...structureTrimChains(result, config, levelConfig)];
  const allRuns = chains.flat();

  const openingRects = new Map(allRuns.map((run) => [run.id, []]));
  (result.openings ?? []).filter((entry) => entry.resolved && entry.host).forEach(({ resolved, host }) => {
    const run = allRuns.find((candidate) => candidate.id === resolved.hostWallRunId);
    if (!run) {
      return;
    }
    const { outer } = openingOutline(resolved);
    const us = outer.map(([u]) => u);
    const vs = outer.map(([, v]) => v);
    openingRects.get(run.id).push({
      from: Math.min(...us) + run.length / 2, to: Math.max(...us) + run.length / 2, minY: host.baseY + Math.min(...vs), maxY: host.baseY + Math.max(...vs),
    });
  });
  // one course along one chain: where each run carries it (`anchorOf`, a height or null), the parts it covers
  const sweepChain = (chain, anchorOf, extent, sweep) => sweep(chain.map((run) => {
    const y = anchorOf(run);
    if (!Number.isFinite(y)) {
      return { ...run, y: null };
    }
    const pieces = coursePieces(run, openingRects.get(run.id), y + extent.min, y + extent.max);
    return pieces.length ? { ...run, y, pieces } : { ...run, y: null };
  }));

  const material = paletteMaterial(trim.material, 'trim');
  const addMesh = (kind, triangles) => {
    if (!triangles.length) {
      return;
    }
    const mesh = new THREE.Mesh(trianglesToGeometry(triangles), material);
    mesh.userData = { bodyPart: 'trim', trimKind: kind };
    result.building.add(mesh);
  };
  // one course along every chain, on the walls it runs along (see courseOn)
  const eachChain = (kind, anchorOf, extent, sweep) => chains.flatMap((chain) => sweepChain(
    chain,
    (run) => (courseOn(trim, wallTrim, run.id, kind) ? anchorOf(run) : null),
    extent,
    sweep
  ));

  if (anyOn('waterTable')) {
    const profile = courseProfile('waterTable', trim.waterTable);
    addMesh('waterTable', eachChain('waterTable', (run) => run.waterY, profileExtent(profile), (ring) => sweepCourse(ring, profile)));
  }
  if (anyOn('beltCourse')) {
    const profile = courseProfile('beltCourse', trim.beltCourse);
    const extent = profileExtent(profile);
    const levels = [...new Set(allRuns.flatMap((run) => run.floorLines).map((y) => y.toFixed(6)))].map(Number);
    addMesh('beltCourse', levels.flatMap((level) => eachChain(
      'beltCourse',
      (run) => run.floorLines.find((y) => Math.abs(y - level) < 1e-5) ?? null,
      extent,
      (ring) => sweepCourse(ring, profile)
    )));
  }
  if (trim.gutters.enabled) {
    // each eave's edge, read off the built roof (not the walls' roles, which needn't follow the roof as built):
    // an edge that overhangs the wall and runs level along it is an eave; one that slopes is a rake
    const roof = mainRoofTriangles(result.building);
    const ring = gutterRing(houseRuns.map((run) => {
      const at = (t, d) => [
        run.start[0] + (run.end[0] - run.start[0]) * t + run.normal[0] * d,
        run.start[1] + (run.end[1] - run.start[1]) * t + run.normal[1] * d,
      ];
      let depth = 0;
      for (let d = 0.02; d <= 2 + 1e-9 && highestSurfaceAt(roof, ...at(0.5, d)) > run.baseY; d += 0.02) {
        depth = d;
      }
      const edge = [0.2, 0.5, 0.8].map((t) => highestSurfaceAt(roof, ...at(t, Math.max(0, depth - 0.03))));
      const level = edge.every(Number.isFinite) && Math.max(...edge) - Math.min(...edge) < 0.02;
      return { ...run, eave: depth > 0.05 && level ? { depth, y: Math.min(...edge) } : null };
    }));
    addMesh('gutter', sweepCourse(ring, GUTTER_PROFILE));
    if (trim.gutters.downspouts) {
      addMesh('downspout', downspoutParts(ring).flatMap(chimneyPartTriangles));
    }
  }
  if (trim.corners.style !== 'none') {
    // from on top of the water table (or the floor) up under the cornice and its dentils (or the wall top)
    const dentilDrop = trim.cornice.dentils ? dentilSize(trim.cornice).height : 0;
    addMesh('corners', cornerTriangles(houseRuns.map((run) => ({
      ...run,
      y0: courseOn(trim, wallTrim, run.id, 'waterTable') && Number.isFinite(run.waterY) ? run.waterY + trim.waterTable.height : run.baseY,
      y1: courseOn(trim, wallTrim, run.id, 'cornice') ? run.corniceY - trim.cornice.height - dentilDrop : run.plateY,
    })), trim.corners));
  }
  if (anyOn('cornice')) {
    const profile = courseProfile('cornice', trim.cornice);
    addMesh('cornice', eachChain('cornice', (run) => run.corniceY, profileExtent(profile), (ring) => sweepCourse(ring, profile)));
    if (trim.cornice.dentils) {
      const size = dentilSize(trim.cornice);
      addMesh('dentils', eachChain('cornice', (run) => run.corniceY - trim.cornice.height, { min: -size.height, max: 0 }, (ring) => dentilTriangles(ring, size)));
    }
  }
  return result;
}

/**
 * Each roof structure's walls as a chain of trim runs, in the house walls'
 * own frame (as structureOpeningHost puts them: start and end swapped, u
 * mirrored) and chained end to start, so its courses miter round its
 * corners and end square where it meets the house. A run keeps its visible
 * shape, which limits every course to where the wall shows across the
 * course's whole height (a dormer's cheek only near its front, a tower above
 * the house roof). A structure carries the house's water table where its
 * walls come down to the host's foundation top, the host volume's belt
 * courses where it spans those floor lines, and its own cornice under its
 * own roof's soffit at its plate.
 */
function structureTrimChains(result, config, levelConfig) {
  const resolvedById = new Map((result.roofStructures ?? []).filter((entry) => entry.resolved).map((entry) => [entry.resolved.id, entry.resolved]));
  return (result.structureFacades ?? []).map((facade) => {
    const resolved = resolvedById.get(facade.structureId);
    if (!resolved) {
      return [];
    }
    const hostVolumeId = resolved.hostVolumeId ?? null;
    const hostBase = volumeFoundationHeight(hostVolumeId, levelConfig);
    const { count, height, hasKneeWall } = volumeStories(hostVolumeId, config);
    const lines = floorLines(count, height, hasKneeWall).map((line) => hostBase + line);
    const runs = facade.wallRuns.filter((run) => !run.wall.startsWith('base-')).map((run) => ({
      id: run.id,
      start: run.end,
      end: run.start,
      normal: run.normal,
      length: run.length,
      baseY: run.baseY,
      wallHeight: resolved.plateY - resolved.sillY,
      plateY: resolved.plateY,
      shape: run.pieces.map((triangle) => triangle.map(([u, v]) => [run.length - u, v])),
      waterY: hostBase > 0.01 ? hostBase : null,
      floorLines: lines,
    }));
    const roofTriangles = [];
    result.building.children.filter((child) => child.isMesh && child.userData?.structureId === facade.structureId && child.userData.structurePart === 'roof')
      .forEach((mesh) => roofTriangles.push(...geometryTriangles(mesh.geometry).map((tri) => tri.map(([x, y, z]) => [x + mesh.position.x, y + mesh.position.y, z + mesh.position.z]))));
    const measured = Math.min(...runs.map((run) => soffitAbove(run, roofTriangles, run.baseY + run.wallHeight * 0.5)));
    const top = Math.min(resolved.plateY, measured - CORNICE_SOFFIT_GAP);
    runs.forEach((run) => {
      run.corniceY = top;
    });
    return chainRuns(runs);
  }).filter((chain) => chain.length);
}

/** The lowest roof surface above points just outside a run (see corniceTops). */
function soffitAbove(run, triangles, floorY) {
  let lowest = Infinity;
  [0.15, 0.5, 0.85].forEach((t) => {
    const x = run.start[0] + (run.end[0] - run.start[0]) * t + run.normal[0] * SOFFIT_PROBE_OFFSET;
    const z = run.start[1] + (run.end[1] - run.start[1]) * t + run.normal[1] * SOFFIT_PROBE_OFFSET;
    lowest = Math.min(lowest, lowestSurfaceAbove(triangles, x, z, floorY));
  });
  return lowest;
}

/** Runs put in order end to start, from one no other run leads into (or any, when they close a ring). */
function chainRuns(runs) {
  const meets = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;
  const left = [...runs];
  const chain = [];
  while (left.length) {
    let run = left.find((candidate) => !left.some((other) => other !== candidate && meets(other.end, candidate.start))) ?? left[0];
    while (run) {
      chain.push(run);
      left.splice(left.indexOf(run), 1);
      const current = run;
      run = left.find((candidate) => meets(current.end, candidate.start));
    }
  }
  return chain;
}

/**
 * A built building with its roof structures (withRoofStructures), its
 * windows and doors (withOpenings), its trim courses (withTrim), and its
 * widow's walks' facade surfaces
 * (`roofWalks`): a continuous hip's (`skeletonWalks`, already at their
 * elevation) and each volume's own.
 */
function withStructuresAndWalks(built, config, skeletonWalks = []) {
  const walks = [...skeletonWalks, ...built.roofZones.filter((zone) => !zone.skeleton).flatMap(zoneWalk)];
  const result = withChimneys(withTrim(withOpenings(withPorchSteps(withRoofStructures(built, config), config), config), config), config);
  // railings stop at anything standing on the walk
  const standing = result.structureSolids ?? [];
  delete result.structureSolids;
  const roofWalks = walks.map((walk) => roofWalkFacade(walk, standing));
  addRailings(result, config, roofWalks);
  delete result.railGaps;
  delete result.stairRails;
  delete result.stepPlans;
  return { ...result, roofWalks };
}

/**
 * A volume's widow's walk, if its roof has one: the flat top where the walk
 * plane is the lowest of its roof planes, with its edges (where the roof
 * slopes away).
 */
function zoneWalk(zone) {
  const walkPlane = zone.planes.find((plane) => plane.tier === 'walk');
  if (!walkPlane) {
    return [];
  }
  const { bounds } = zone;
  let region = [[bounds.minX, bounds.minZ], [bounds.maxX, bounds.minZ], [bounds.maxX, bounds.maxZ], [bounds.minX, bounds.maxZ]];
  zone.planes.filter((plane) => plane !== walkPlane).forEach((plane) => {
    region = clipPolygon(region, ([x, z]) => evalPlaneHeight(plane, x, z) - walkPlane.constantHeight);
  });
  if (region.length < 3) {
    return [];
  }
  const onWall = ([x, z]) => [x - bounds.minX, bounds.maxX - x, z - bounds.minZ, bounds.maxZ - z].some((d) => Math.abs(d) < 1e-9);
  const edges = region.map((point, i) => [point, region[(i + 1) % region.length]])
    .filter(([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-6 && !(onWall(a) && onWall(b) && (Math.abs(a[0] - b[0]) < 1e-9 || Math.abs(a[1] - b[1]) < 1e-9)));
  return [{
    id: `roof-walk-${zone.volumeId}`,
    volumeIds: [zone.volumeId],
    height: walkPlane.constantHeight,
    y: zone.baseY + walkPlane.constantHeight,
    pieces: [region],
    edges,
  }];
}

/**
 * The height of a volume's walls above its foundation: its stories (its own
 * count, `volumeStoryOverrides`, or the building's, each its own height,
 * `volumeStoryHeights`, or the building's `storyHeight`), plus the knee wall of a
 * half story above them if it has one (a story and a half: the top floor
 * rises only that far before the roof starts; `volumeKneeWalls`, or the
 * building's `kneeWallHeight`). Without a volume id, the building's.
 */
export function volumeWallHeight(volumeId, config = {}) {
  const stories = (volumeId && config.volumeStoryOverrides?.[volumeId]) ?? config.storyCount ?? 1;
  const ownStory = volumeId ? config.volumeStoryHeights?.[volumeId] : undefined;
  const storyHeight = ownStory > 0 ? ownStory : config.storyHeight ?? 3.2;
  const own = volumeId ? config.volumeKneeWalls?.[volumeId] : undefined;
  const knee = Number.isFinite(own) ? own : config.kneeWallHeight;
  return stories * storyHeight + (knee > 0 ? knee : 0);
}

/**
 * The height of a volume's floor above grade: its foundation (its own,
 * `volumeFoundationHeights`, such as a garage slab at grade, or the
 * building's `foundationDepth`). Without a volume id, the building's.
 */
export function volumeFoundationHeight(volumeId, config = {}) {
  const own = volumeId ? config.volumeFoundationHeights?.[volumeId] : undefined;
  return Number.isFinite(own) && own >= 0 ? own : config.foundationDepth ?? 0.6;
}

/**
 * Adds the roof structures in `config.roofStructures` (dormers, raised
 * porches; see js/roof-structures.js) to a built building. Each valid
 * structure gets walls and a roof built too large and clipped to what lies
 * outside its host volume's solid, and every roof mesh is cut by the
 * structure's own solid, so the two meet along the same lines as one shell.
 * `roofStructures` in the result holds every structure's validation result
 * (errors and warnings for the ones that were not built).
 */
function withRoofStructures(result, config) {
  const structures = config.roofStructures ?? [];
  if (structures.length === 0) {
    return { ...result, roofStructures: [], structureFacades: [] };
  }
  const results = validateRoofStructures(structures, result.roofZones, config, {
    describeStructure: (resolved) => {
      const setup = structureEaveSetup(resolved, config);
      return { overhang: setup.overhang, eaves: setup.eaves };
    },
  });
  // lowest first: a structure standing on another is built after it
  const built = results.filter((entry) => entry.resolved).sort((a, b) => a.resolved.level - b.resolved.level);
  if (built.length === 0) {
    return { ...result, roofStructures: results, structureFacades: [] };
  }
  const materials = createMaterials(config);
  const roofMeshes = [];
  result.building.traverse((child) => {
    if (child.isMesh && child.userData?.roofType) {
      roofMeshes.push(child);
    }
  });
  const builtSolids = [];
  result.structureFacades = [];
  const clipOutside = (triangles, solids) => solids.reduce((kept, solid) => clipOutsideConvexSolid(kept, solid), triangles);

  // add a structure's parts, cut every roof it runs into, and keep its solid
  const finish = (resolved, host, parts) => {
    parts.forEach(([part, triangles, material]) => {
      if (triangles.length) {
        const mesh = new THREE.Mesh(trianglesToGeometry(triangles), material);
        mesh.userData = {
          structureId: resolved.id, recordId: resolved.recordId, structurePart: part, hostVolumeId: host.volumeId,
        };
        result.building.add(mesh);
        if (part === 'roof') {
          roofMeshes.push(mesh); // a structure standing on this one cuts it too
        }
      }
    });

    // Cut every roof: the host's, and any neighbor's the structure runs into.
    // A standing structure's solid starts at its floor, so a flat host's slab
    // below the deck goes too; a dormer's reaches down through the host roof.
    const cut = volumeSolid(resolved, { floorY: resolved.standing ? resolved.sillY : 0 });
    // A structure rising through the roof leaves it whole: an enclosed one
    // hides the roof inside it, and an open one stands on it.
    roofMeshes.filter((mesh) => !resolved.through && mesh.userData?.structureId !== resolved.id).forEach((mesh) => {
      const y = mesh.position.y;
      const absolute = geometryTriangles(mesh.geometry).map((tri) => tri.map(([px, py, pz]) => [px, py + y, pz]));
      const kept = clipOutsideConvexSolid(absolute, cut).map((tri) => tri.map(([px, py, pz]) => [px, py - y, pz]));
      mesh.geometry.dispose();
      mesh.geometry = trianglesToGeometry(kept);
    });
    builtSolids.push({ id: resolved.id, solid: volumeSolid(resolved, { floorY: resolved.sillY }) });
  };

  built.forEach(({ resolved, host }) => {
    if (resolved.recess) {
      buildRecess(resolved, host, result, materials);
      return;
    }
    // Every volume and every structure already built is solid too: a porch
    // that runs into a taller neighbor merges into its walls and roof the
    // same way it meets its host.
    const others = [
      ...result.roofZones.filter((zone) => zone.volumeId !== host.volumeId).flatMap((zone) => zoneSolids(zone)),
      ...builtSolids.filter((entry) => entry.id !== host.volumeId).map((entry) => entry.solid),
    ];
    // the space under the host roof: one solid, or one per roof piece
    const hostSolids = zoneSolids(host);
    // The host's body: its walls up to their top, without the roof. A
    // standing structure's floor stops at it, and so do its walls where the
    // host roof over them is cut away (see standingWalls).
    const hostBody = volumeSolid({ ...host, planes: [], slabThickness: 0, baseY: host.wallTopY });
    // A floor lying right on the host's wall top (a porch on a ground porch's
    // roof) is that lower space's ceiling, so it stays: only floor sunk below
    // the wall top, inside the host, is cut away.
    const floorSolids = [volumeSolid({ ...host, planes: [], slabThickness: 0, baseY: host.wallTopY - 1e-3 }), ...others];
    if (resolved.planned) {
      const planned = plannedParts(resolved, host, config, materials, {
        hostSolids, hostBody, others, floorSolids, clipOutside,
      });
      result.structureFacades.push(planned.facade);
      // no notch in the host eave: the structure's own solid cuts it along its outline, onto its walls
      finish(resolved, host, planned.parts);
      return;
    }

    // walls start low enough to meet the host: its roof for a dormer, its
    // wall top (below the roof lift) for a structure standing on a base
    const bottomY = Math.min(resolved.sillY, resolved.standing ? host.wallTopY : host.baseY);
    const walls = structureWallPolygons(resolved, bottomY);
    // A flush front wall stands on the host wall line and carries it up: it
    // runs down to the host wall top, clipped only by other volumes, closing
    // the gap under the host roof that the (now interrupted) eave used to hide.
    const flushFront = resolved.flush
      ? structureWallPolygons(resolved, host.wallTopY).find((wall) => wall.wall === 'front')
      : null;
    // each wall's visible pieces, by name (front, left, right, back, inner): the
    // mesh, and the structure's facade surfaces (see structureFacade)
    const wallFaces = new Map();
    const addFaces = (name, triangles) => {
      if (triangles.length) {
        wallFaces.set(name, [...(wallFaces.get(name) ?? []), ...triangles]);
      }
    };
    walls.forEach((wall) => {
      addFaces(wall.wall, flushFront && wall.wall === 'front'
        ? clipOutside(polygonsToTriangles([flushFront.polygon]), others)
        : standingWalls(polygonsToTriangles([wall.polygon]), resolved, { hostSolids, hostBody, others, clipOutside }));
    });
    const supports = structureSupports(resolved, host);
    const recess = recessParts(resolved, host, walls, { hostSolids, others, clipOutside });
    recess.sides.forEach(([name, triangles]) => addFaces(name, triangles));
    addFaces('inner', recess.inner);
    const skirts = supports.skirts.map(([name, triangles]) => [name, clipOutside(triangles, [...hostSolids, ...others])]);
    result.structureFacades.push(structureFacade(resolved, wallFaces, skirts, [hostBody, ...others]));
    const structureMaterials = materialsFor(resolved, materials);
    const parts = [
      ['walls', [...[...wallFaces.values()].flat(), ...clipOutside(kneeWalls(resolved, host), others), ...recess.liftStrip, ...recess.jambs], structureMaterials.wall],
      ['roof', clipOutside(structureRoofTriangles(resolved, config), [...hostSolids, ...others]), structureMaterials.roof],
      ['floor', [
        ...(resolved.standing && !resolved.hood ? clipOutside(polygonsToTriangles([structureFloorPolygon(resolved)]), floorSolids) : []),
        ...recess.floor,
      ], materials.roof],
      // an entry hood's underside, at its plate
      ['ceiling', resolved.hood ? clipOutside(polygonsToTriangles([structureFloorPolygon(resolved).map(([x, , z]) => [x, resolved.plateY, z])]), [hostBody, ...others]) : [], structureMaterials.wall],
      ['posts', [
        ...clipOutside([
          ...(resolved.standing && !resolved.hood ? openSidePosts(resolved, [hostBody, ...others]) : []),
          ...supports.posts,
        ], [hostBody, ...others]),
        // a structure rising through the roof stands its posts on the roof
        ...(resolved.through
          ? clipOutside(openSidePosts(resolved, others, host.baseY), [...hostSolids, ...others])
          : []),
      ], materials.wall],
      ['support', skirts.flatMap(([, triangles]) => triangles), structureMaterials.wall],
      ['foundation', clipOutside(supports.foundation, [...hostSolids, ...others]), materials.foundation],
      ['eave-caps', interruptsHostEave(resolved, host) ? interruptHostEave(resolved, host, roofMeshes) : [], materials.roof],
    ];
    finish(resolved, host, parts);
  });
  return { ...result, roofStructures: results, structureSolids: builtSolids.map((entry) => entry.solid) };
}

/**
 * A structure with a polygonal plan (see resolvePlanned in
 * js/roof-structures.js: a canted bay, an octagonal or round tower), as parts
 * like any structure's, and its facade surfaces:
 * - walls on each edge of its outline, up to its roof, clipped as a
 *   standing structure's are (a tower on the corner of the house shows
 *   only outside it);
 * - its roof face by face over its outline carried out over the eave on its
 *   eave edges (a flat roof is a slab), with a fascia and soffit along each
 *   eave, capped where an eave ends against an edge with none;
 * - a floor at its sill, and a foundation under one at ground level.
 */
function plannedParts(resolved, host, config, materials, {
  hostSolids, hostBody, others, floorSolids, clipOutside,
}) {
  const {
    outline, planes, plateY, sillY, id,
  } = resolved;
  const count = outline.length;
  const center = [outline.reduce((sum, [x]) => sum + x, 0) / count, outline.reduce((sum, [, z]) => sum + z, 0) / count];
  const edges = outline.map((point, i) => [point, outline[(i + 1) % count]]);
  const structureMaterials = materialsFor(resolved, materials);
  // a bay with no roof of its own (tucked under the eave) is closed flat at its plate
  const roofless = resolved.roofType === 'none';
  const top = resolved.roofType === 'flat' ? plateY + resolved.slabThickness : roofless ? plateY : null;

  // walls on each edge, from low enough to meet the host up to the roof
  const bottomY = Math.min(sillY, resolved.standing ? host.wallTopY : host.baseY);
  const wallFaces = edges.map(([a, b]) => {
    const tops = top !== null
      ? [[b[0], top, b[1]], [a[0], top, a[1]]]
      : roofProfile(planes, a, b).reverse().map(([t, height]) => [a[0] + (b[0] - a[0]) * t, plateY + height, a[1] + (b[1] - a[1]) * t]);
    const polygon = [[a[0], bottomY, a[1]], [b[0], bottomY, b[1]], ...tops];
    return standingWalls(polygonsToTriangles([polygon]), resolved, {
      hostSolids, hostBody, others, clipOutside,
    });
  });

  // the roof, carried out over the eaves
  const eaves = resolveVolumeEaves(id, { ...pickEaveConfig(config), volumeEaves: { [id]: resolved.eaves ?? {} } });
  const depth = eaves.eaveDepth > 1e-9 ? eaves.eaveDepth : 0;
  const isEave = edges.map((_, i) => (resolved.eaveEdges ?? []).includes(i) || resolved.roofType === 'flat');
  const outward = ([a, b]) => {
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    let normal = [(b[1] - a[1]) / length, -(b[0] - a[0]) / length];
    if (normal[0] * (center[0] - a[0]) + normal[1] * (center[1] - a[1]) > 0) {
      normal = [-normal[0], -normal[1]];
    }
    return normal;
  };
  // each outline corner moved out to where its two edges' eave lines meet
  const outer = outline.map((point, i) => {
    const previous = (i + count - 1) % count;
    const [n1, n2] = [outward(edges[previous]), outward(edges[i])];
    const [d1, d2] = [isEave[previous] ? depth : 0, isEave[i] ? depth : 0];
    // solve p + u: n1 . u = d1, n2 . u = d2
    const det = n1[0] * n2[1] - n1[1] * n2[0];
    if (Math.abs(det) < 1e-9) {
      return [point[0] + n2[0] * d2, point[1] + n2[1] * d2];
    }
    return [point[0] + (d1 * n2[1] - d2 * n1[1]) / det, point[1] + (n1[0] * d2 - n2[0] * d1) / det];
  });
  const fascia = eaves.fasciaDepth ?? 0;
  let roof;
  if (roofless) {
    roof = polygonsToTriangles([outline.map(([x, z]) => [x, plateY, z])]);
  } else if (top !== null) {
    // a flat slab over the outline carried out
    const sides = outer.map((point, i) => {
      const next = outer[(i + 1) % count];
      return [[point[0], plateY, point[1]], [next[0], plateY, next[1]], [next[0], top, next[1]], [point[0], top, point[1]]];
    });
    roof = polygonsToTriangles([outer.map(([x, z]) => [x, top, z]), outer.map(([x, z]) => [x, plateY, z]).reverse(), ...sides]);
  } else {
    const heightAt = (point) => evalZoneHeight(planes, point[0], point[1]);
    const faces = planes.map((plane, k) => {
      let face = outer.map(([x, z]) => [x, z]);
      planes.forEach((other, j) => {
        if (j !== k && face.length >= 3) {
          const bias = j < k ? 1e-9 : 0;
          face = clipPolygon(face, ([x, z]) => evalPlaneHeight(other, x, z) - evalPlaneHeight(plane, x, z) - bias);
        }
      });
      return face.length >= 3 ? face.map(([x, z]) => [x, plateY + evalPlaneHeight(plane, x, z), z]) : null;
    }).filter(Boolean);
    const trim = [];
    edges.forEach(([a, b], i) => {
      if (!isEave[i] || depth <= 0) {
        return;
      }
      const [oa, ob] = [outer[i], outer[(i + 1) % count]];
      const [ya, yb] = [plateY + heightAt(oa), plateY + heightAt(ob)];
      trim.push([[oa[0], ya, oa[1]], [ob[0], yb, ob[1]], [ob[0], yb - fascia, ob[1]], [oa[0], ya - fascia, oa[1]]]);
      const inner = (y) => (eaves.eaveSoffit === 'sloped' ? plateY - fascia : y - fascia);
      trim.push([[a[0], inner(ya), a[1]], [oa[0], ya - fascia, oa[1]], [ob[0], yb - fascia, ob[1]], [b[0], inner(yb), b[1]]]);
      // an eave ending against an edge without one is capped with its section
      [[i, a, oa, ya, (i + count - 1) % count], [i, b, ob, yb, (i + 1) % count]].forEach(([, wallPoint, outerPoint, y, neighbor]) => {
        if (!isEave[neighbor]) {
          trim.push([[wallPoint[0], plateY, wallPoint[1]], [outerPoint[0], y, outerPoint[1]], [outerPoint[0], y - fascia, outerPoint[1]], [wallPoint[0], inner(y), wallPoint[1]]]);
        }
      });
    });
    roof = polygonsToTriangles([...faces, ...trim]);
  }

  // the floor, and a foundation under one at ground level
  const floor = resolved.standing ? clipOutside(polygonsToTriangles([outline.map(([x, z]) => [x, sillY, z])]), floorSolids) : [];
  const foundation = resolved.support === 'deck' && sillY > 1e-9
    ? clipOutside(polygonsToTriangles([
      outline.map(([x, z]) => [x, 0, z]).reverse(),
      ...edges.map(([a, b]) => [[a[0], 0, a[1]], [b[0], 0, b[1]], [b[0], sillY, b[1]], [a[0], sillY, a[1]]]),
    ]), [...hostSolids, ...others])
    : [];

  // a turret on brackets is carried on a corbel: a cone (or pyramid) tapering
  // from its floor to a point below its center, cut off where it meets the house
  const across = Math.max(...outline.map(([x, z]) => Math.hypot(x - center[0], z - center[1]))) * 2;
  const corbel = resolved.support === 'brackets' && resolved.standing && sillY > (host.foundationTopY ?? 0) + 1e-6
    ? clipOutside(edges.map(([a, b]) => [[b[0], sillY, b[1]], [a[0], sillY, a[1]], [center[0], sillY - CORBEL_DEPTH * across, center[1]]]), [...hostSolids, ...others])
    : [];

  const storyId = `story-${id}-1`;
  const common = { structureId: id, hostVolumeId: resolved.hostVolumeId, storyId };
  const wallRuns = wallFaces.map((triangles, i) => (triangles.length
    ? facadeWallRun(`wall-run-${id}-facet-${i + 1}`, { ...common, wall: `facet-${i + 1}`, side: null }, edgeFrame(edges[i][0], edges[i][1], center), triangles, sillY)
    : null)).filter(Boolean);
  return {
    parts: [
      ['walls', wallFaces.flat(), structureMaterials.wall],
      ['roof', clipOutside(roof, [...hostSolids, ...others]), structureMaterials.roof],
      ['floor', floor, materials.roof],
      ['foundation', foundation, materials.foundation],
      ['corbel', corbel, structureMaterials.wall],
    ],
    facade: {
      structureId: id, wallRuns, stories: [{ id: storyId, structureId: id, minY: sillY, maxY: plateY }], railRuns: [],
    },
  };
}

/**
 * A recessed structure (see resolveRecess in js/roof-structures.js): cuts the
 * host's walls and facade panels away inside its box, carried a little past
 * the wall so panels standing proud of it go too, and adds its back and
 * closed side walls, a ceiling, a floor above the ground, and posts at its
 * open corners. The host roof is left whole.
 */
function buildRecess(resolved, host, result, materials) {
  const { bounds, sillY, plateY } = resolved;
  const sides = structureWallSides(resolved.frame);
  const proud = 0.05;
  const openBounds = { ...bounds };
  resolved.openSides.forEach((wallName) => {
    const side = sides[wallName];
    openBounds[side] += side.startsWith('min') ? -proud : proud;
  });
  const cut = volumeSolid({ bounds: openBounds, baseY: plateY, planes: [], slabThickness: 0 }, { floorY: sillY });
  result.building.traverse((child) => {
    if (!child.isMesh || !child.userData?.bodyPart) {
      return;
    }
    const y = child.position.y;
    const absolute = geometryTriangles(child.geometry).map((tri) => tri.map(([px, py, pz]) => [px, py + y, pz]));
    const kept = clipOutsideConvexSolid(absolute, cut).map((tri) => tri.map(([px, py, pz]) => [px, py - y, pz]));
    child.geometry.dispose();
    child.geometry = trianglesToGeometry(kept);
  });
  const walls = structureWallPolygons(resolved, sillY);
  const wallFaces = new Map(walls.map((wall) => [wall.wall, polygonsToTriangles([wall.polygon])]));
  const rectangle = (y) => [[bounds.minX, y, bounds.minZ], [bounds.maxX, y, bounds.minZ], [bounds.maxX, y, bounds.maxZ], [bounds.minX, y, bounds.maxZ]];
  const aboveGround = !Number.isFinite(resolved.foundationTopY) || sillY > resolved.foundationTopY + 1e-6;
  // a walk-in room's floor was cut away with the rest (there's no solid foundation top under it)
  const hollow = Boolean(result.building.userData.interiorRooms?.length);
  // where the host's eave soffit meets its wall below the ceiling, the host
  // wall carries on down to it across the opening
  const headers = resolved.openSides.flatMap((wallName) => {
    const side = sides[wallName];
    if (Math.abs(bounds[side] - host.bounds[side]) > 1e-6) {
      return [];
    }
    const alongKey = side === 'minX' || side === 'maxX' ? 'Z' : 'X';
    const ends = [bounds[`min${alongKey}`], bounds[`max${alongKey}`]];
    const soffits = ends.map((along) => hostEaveProfile(host, side, along))
      .filter(Boolean)
      .map(({ outline }) => Math.min(...outline.filter(([u]) => Math.abs(u - host.bounds[side]) < 1e-9).map(([, v]) => v)));
    const bottom = soffits.length ? host.baseY + Math.min(...soffits) : plateY;
    if (bottom >= plateY - 1e-9) {
      return [];
    }
    const point = (along, y) => (alongKey === 'X' ? [along, y, bounds[side]] : [bounds[side], y, along]);
    return polygonsToTriangles([[point(ends[0], bottom), point(ends[1], bottom), point(ends[1], plateY), point(ends[0], plateY)]]);
  });
  const structureMaterials = materialsFor(resolved, materials);
  const parts = [
    ['walls', [...wallFaces.values()].flat(), structureMaterials.wall],
    ['header', headers, materials.wall],
    ['ceiling', polygonsToTriangles([rectangle(plateY)]), structureMaterials.wall],
    // on the ground the host's foundation top is the floor (unless the host is hollow)
    ['floor', aboveGround || hollow ? polygonsToTriangles([rectangle(sillY)]) : [], materials.roof],
    ['posts', openSidePosts(resolved, []), structureMaterials.wall],
  ];
  parts.forEach(([part, triangles, material]) => {
    if (triangles.length) {
      const mesh = new THREE.Mesh(trianglesToGeometry(triangles), material);
      mesh.userData = {
        structureId: resolved.id, recordId: resolved.recordId, structurePart: part, hostVolumeId: host.volumeId,
      };
      result.building.add(mesh);
    }
  });
  result.structureFacades.push(structureFacade(resolved, wallFaces, [], []));
}

/**
 * A structure's wall and roof materials: its own palette choices
 * (`materials.wall`, `materials.roof`, keys of MATERIAL_PALETTE) over the
 * building's. Material precedence runs facade panel, wall run, structure,
 * volume, story, building.
 */
function materialsFor(resolved, materials) {
  const pick = (key, fallback) => (MATERIAL_PALETTE[resolved.materials?.[key]]
    ? paletteMaterial(resolved.materials[key], key)
    : fallback);
  return { wall: pick('wall', materials.wall), roof: pick('roof', materials.roof) };
}

/**
 * The open porch an inset leaves at the front of a structure (see
 * structureRecess): its floor, the inner wall across its back, and, for a
 * dormer, the side walls run on down to the floor inside it (the host roof
 * there is cut away with the rest of the dormer's footprint). A flush recess
 * also closes the roof-lift gap under its front edge, which a flush front
 * wall would otherwise have covered.
 */
function recessParts(resolved, host, walls, { hostSolids, others, clipOutside }) {
  const recess = structureRecess(resolved);
  if (!recess) {
    return {
      sides: [], inner: [], liftStrip: [], floor: [], jambs: [],
    };
  }
  const belowFloor = [{ normal: [0, 1, 0], offset: resolved.sillY }];
  const sides = resolved.standing
    ? []
    : walls.map((wall) => [wall.wall, clipOutside(
      hostSolids.flatMap((solid) => clipInsideConvexSolid(clipInsideConvexSolid(polygonsToTriangles([wall.polygon]), planPrism(recess.plan)), solid)),
      [belowFloor, ...others]
    )]);
  const [p0, p1] = recess.plan; // the front edge
  const liftStrip = resolved.flush && host.wallTopY < resolved.sillY - 1e-9
    ? [[[p0[0], host.wallTopY, p0[1]], [p1[0], host.wallTopY, p1[1]], [p1[0], resolved.sillY, p1[1]], [p0[0], resolved.sillY, p0[1]]]]
    : [];
  return {
    sides,
    inner: clipOutside(polygonsToTriangles([recess.innerWall]), others),
    liftStrip: clipOutside(polygonsToTriangles(liftStrip), others),
    floor: resolved.standing ? [] : clipOutside(polygonsToTriangles([recess.floor]), others),
    // the jambs where the open recess cuts off the side walls, given a stud
    // wall's worth of visible thickness instead of a knife-edge (see
    // structureRecess); a standing structure's post already reads as thick
    // there, so this is only for one rising out of the roof (a dormer).
    jambs: resolved.standing ? [] : clipOutside(polygonsToTriangles(recess.jambs), others),
  };
}

/** Post size (square) and the longest span between posts along an open side or a supported front. */
/** How deep a turret's corbel runs below its floor, as a share of its diameter. */
const CORBEL_DEPTH = 0.6;

const POST_SIZE = 0.2;
const MAX_POST_SPAN = 3;

/**
 * Surface of an axis-aligned box, its `y1` (top) and/or `y0` (bottom) faces
 * left off on request — for a box standing in for solid ground under a
 * feature that already has its own cap at that height (a deck's floor, a
 * post's underside), so the two don't coincide and z-fight.
 */
function boxTriangles([x0, y0, z0], [x1, y1, z1], { top = true, bottom = true } = {}) {
  const p = (i) => [i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0];
  const faces = [
    [0, 2, 3, 1], [4, 5, 7, 6],
    ...(bottom ? [[0, 1, 5, 4]] : []),
    ...(top ? [[2, 6, 7, 3]] : []),
    [0, 4, 6, 2], [1, 3, 7, 5],
  ];
  return faces.flatMap(([a, b, c, d]) => [[p(a), p(b), p(c)], [p(a), p(c), p(d)]]);
}

/** Evenly spaced positions from `a` to `b`, no more than `span` apart, ends included. */
function spacedPositions(a, b, span) {
  const count = Math.max(1, Math.ceil(Math.abs(b - a) / span - 1e-9));
  return Array.from({ length: count + 1 }, (_, i) => a + ((b - a) * i) / count);
}

/**
 * A square post standing at plan point `at`, pushed inside the structure's
 * rectangle so its faces are flush with the rectangle's sides, from `y0` to `y1`.
 */
function postBox(bounds, at, y0, y1, style = 'square') {
  const rect = postRect(bounds, at);
  // a styled post (js/posts.js) stands in the same square
  return style && style !== 'square' ? postTriangles(style, rect, y0, y1) : boxTriangles([rect.minX, y0, rect.minZ], [rect.maxX, y1, rect.maxZ]);
}

/**
 * Posts holding up the roof along a structure's open sides: at each end and
 * no more than MAX_POST_SPAN apart, from floor (or `bottomY`) to plate. An end against a
 * closed wall of its own, or against the host or another volume (where the
 * roof bears on that wall), gets no post.
 */
function openSidePosts(resolved, solids, bottomY = resolved.sillY) {
  return openSidePostPoints(resolved, solids).flatMap((point) => postBox(resolved.bounds, point, bottomY, resolved.plateY, resolved.postStyle));
}

/** Where openSidePosts stands its posts, as plan points (each post pushed inside the rectangle, see postBox). */
function openSidePostPoints(resolved, solids) {
  const sides = structureWallSides(resolved.frame);
  const { bounds, sillY, plateY } = resolved;
  const closedSides = Object.entries(sides).filter(([wallName]) => !resolved.openSides.includes(wallName)).map(([, side]) => side);
  const onClosedWall = ([x, z]) => closedSides.some((side) => Math.abs((side === 'minX' || side === 'maxX' ? x : z) - bounds[side]) < 1e-6);
  const midY = (sillY + plateY) / 2;
  const againstSolid = ([x, z]) => solids.some((solid) => isInsideSolid([x, midY, z], solid, 1e-3));
  const points = new Map();
  resolved.openSides.filter((wallName) => !resolved.seamSides?.includes(wallName)).forEach((wallName) => {
    const side = sides[wallName];
    const [a, b] = side === 'minX' || side === 'maxX'
      ? [[bounds[side], bounds.minZ], [bounds[side], bounds.maxZ]]
      : [[bounds.minX, bounds[side]], [bounds.maxX, bounds[side]]];
    const k = side === 'minX' || side === 'maxX' ? 1 : 0;
    // only the stretch of the side standing clear of the host and other volumes
    const opening = wallName === 'front' ? porchStepOpening(resolved) : null;
    const positions = opening ? framedPositions(a[k], b[k], opening) : spacedPositions(a[k], b[k], MAX_POST_SPAN);
    positions.forEach((t) => {
      const point = k === 1 ? [a[0], t] : [t, a[1]];
      if (!onClosedWall(point) && !againstSolid(point)) {
        points.set(point.map((v) => v.toFixed(6)).join(','), point);
      }
    });
  });
  return [...points.values()];
}

/** How far a porch's steps can move either way from the middle of a front `length` long, `width` wide, staying 0.1 m clear of its ends. */
export function porchStepTravel(length, width) {
  return Math.max(0, (length - width) / 2 - 0.1);
}

/**
 * Post positions along a side from `a` to `b` framing a steps opening
 * (`from`..`to`): a post either side of it, its face on the opening's edge,
 * and the stretches out to the corners spaced as usual. A framing post that
 * would crowd a corner post is left to the corner post.
 */
function framedPositions(a, b, { from, to }) {
  const s = POST_SIZE;
  const left = from - s / 2;
  const right = to + s / 2;
  return [
    ...(left - a >= s ? spacedPositions(a, left, MAX_POST_SPAN) : [a]),
    ...(b - right >= s ? spacedPositions(right, b, MAX_POST_SPAN) : [b]),
  ];
}

/** The plan rectangle a post at `point` covers (as postBox places it). */
function postRect(bounds, [x, z]) {
  const s = POST_SIZE;
  const clampTo = (value, lo, hi) => Math.min(Math.max(value - s / 2, lo), hi - s);
  const minX = clampTo(x, bounds.minX, bounds.maxX);
  const minZ = clampTo(z, bounds.minZ, bounds.maxZ);
  return {
    minX, maxX: minX + s, minZ, maxZ: minZ + s,
  };
}

/**
 * What holds up the part of a projecting structure past its host wall (see
 * `support` in js/roof-structures.js), as triangles grouped by material:
 * - `deck`: a solid base from grade to the floor;
 * - `posts`: posts from grade to the floor along the front, no more than
 *   MAX_POST_SPAN apart;
 * - `porch`: the same posts standing on a ground-level deck;
 * - `brackets`: triangular braces under the floor, back to the wall;
 * - `enclosed`: walls from the foundation to the floor on the projecting
 *   sides (`skirts`, by wall name), over a foundation.
 */
function structureSupports(resolved, host) {
  const empty = { posts: [], skirts: [], foundation: [] };
  if (!resolved.projecting || resolved.support === 'none') {
    return empty;
  }
  const { frame, bounds, sillY } = resolved;
  const groundY = 0;
  const foundationY = Math.min(resolved.foundationTopY ?? host.foundationTopY ?? 0, sillY);
  const wall = resolved.wallLine;
  const front = resolved.front;
  const [a0, a1] = resolved.along;
  // the projecting part's rectangle, in plan
  const [i0, i1] = [Math.min(front, wall), Math.max(front, wall)];
  // a base reaching the floor leaves its top off: the floor is there (two
  // coplanar faces would z-fight)
  const box = (y0, y1, options) => (frame.along === 'x'
    ? boxTriangles([a0, y0, i0], [a1, y1, i1], options)
    : boxTriangles([i0, y0, a0], [i1, y1, a1], options)
  ).filter((triangle) => !(y1 >= sillY - 1e-9 && triangle.every((point) => Math.abs(point[1] - y1) < 1e-9)));
  const frontPoint = (along) => (frame.along === 'x' ? [along, front] : [front, along]);
  const frontPosts = (y0) => spacedPositions(a0, a1, MAX_POST_SPAN).flatMap((along) => postBox(bounds, frontPoint(along), y0, sillY));
  switch (resolved.support) {
    case 'deck':
      // No top face: it would sit exactly on top of, and z-fight with, the
      // floor part built separately at this same sillY (unlike the other
      // cases' foundation, which tops out lower, at a plinth posts or a
      // skirt bridge the rest of the way up from).
      return { ...empty, foundation: box(groundY, sillY, { top: false }) };
    case 'posts':
      return { ...empty, posts: frontPosts(groundY) };
    case 'porch':
      return { ...empty, posts: frontPosts(foundationY), foundation: box(groundY, foundationY) };
    case 'enclosed': {
      const skirts = STRUCTURE_WALLS_BELOW.map((wallName) => [wallName, enclosedBaseWall(resolved, wallName, foundationY, sillY)]);
      return { ...empty, skirts, foundation: box(groundY, foundationY) };
    }
    case 'brackets': {
      const projection = Math.abs(front - wall);
      const thickness = POST_SIZE * 0.6;
      const reach = projection * 0.85;
      return {
        ...empty,
        posts: spacedPositions(a0 + thickness / 2, a1 - thickness / 2, MAX_POST_SPAN * 0.6).flatMap((along) => {
          // a right triangle in the (inward, y) plane: along the floor (a hood's
          // ceiling), then down the wall
          const outward = -frame.sign;
          const braceY = resolved.hood ? resolved.plateY : sillY;
          const section = [[wall, braceY], [wall + outward * reach, braceY], [wall, braceY - reach]];
          const at = (t, [c, y]) => (frame.along === 'x' ? [t, y, c] : [c, y, t]);
          const [s0, s1] = [along - thickness / 2, along + thickness / 2];
          const near = section.map((point) => at(s0, point));
          const far = section.map((point) => at(s1, point));
          return [
            near, [far[0], far[2], far[1]],
            ...[0, 1, 2].flatMap((i) => {
              const j = (i + 1) % 3;
              return [[near[i], near[j], far[j]], [near[i], far[j], far[i]]];
            }),
          ];
        }),
      };
    }
    default:
      return empty;
  }
}

const STRUCTURE_WALLS_BELOW = ['front', 'left', 'right'];

/** One wall of an enclosed base, on the projecting part of the named side, from `y0` to `y1`. */
function enclosedBaseWall(resolved, wallName, y0, y1) {
  const { frame, bounds } = resolved;
  const side = structureWallSides(frame)[wallName];
  const sideAxis = side === 'minX' || side === 'maxX' ? 'x' : 'z';
  const at = bounds[side];
  // the front runs the structure's width; a side wall only its projecting part
  const [alongMinKey, alongMaxKey] = frame.along === 'x' ? ['minX', 'maxX'] : ['minZ', 'maxZ'];
  const [t0, t1] = sideAxis === frame.inward
    ? [bounds[alongMinKey], bounds[alongMaxKey]]
    : [Math.min(resolved.front, resolved.wallLine), Math.max(resolved.front, resolved.wallLine)];
  const point = (t, y) => (sideAxis === 'x' ? [at, y, t] : [t, y, at]);
  return polygonsToTriangles([[point(t0, y0), point(t1, y0), point(t1, y1), point(t0, y1)]]);
}

/**
 * Knee walls under the host roof around the part a standing structure
 * removes: along each edge of the removed region that no structure wall
 * covers (where the structure's roof meets the host roof partway up a
 * slope, along an open side, and across the gap between the host wall top
 * and its roof), a vertical face from the host wall top up to the host roof
 * closes off the host's attic.
 */
function kneeWalls(resolved, host) {
  if (!resolved.standing) {
    return [];
  }
  const sides = structureWallSides(resolved.frame);
  const { bounds } = resolved;
  const closedLines = Object.entries(sides)
    .filter(([wallName]) => !resolved.openSides.includes(wallName))
    .map(([, side]) => [side === 'minX' || side === 'maxX' ? 0 : 1, bounds[side]]);
  const roofY = (point) => host.baseY + zoneRoofHeight(host, point);
  const pieces = resolved.removedRoof;
  const insidePiece = (point, piece) => piece.every(([x0, z0], i) => {
    const [x1, z1] = piece[(i + 1) % piece.length];
    const signedArea = piece.reduce((sum, [ax, az], k) => {
      const [bx, bz] = piece[(k + 1) % piece.length];
      return sum + ax * bz - bx * az;
    }, 0);
    return Math.sign(signedArea) * ((x1 - x0) * (point[1] - z0) - (z1 - z0) * (point[0] - x0)) >= -1e-9;
  });
  const knees = [];
  pieces.forEach((piece, index) => {
    const signedArea = piece.reduce((sum, [ax, az], k) => {
      const [bx, bz] = piece[(k + 1) % piece.length];
      return sum + ax * bz - bx * az;
    }, 0);
    piece.forEach((p0, i) => {
      const p1 = piece[(i + 1) % piece.length];
      if (Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) < 1e-6) {
        return;
      }
      // a closed structure wall stands on this edge
      if (closedLines.some(([k, value]) => Math.abs(p0[k] - value) < 1e-6 && Math.abs(p1[k] - value) < 1e-6)) {
        return;
      }
      // the host roof is removed on both sides (a ridge or hip line between pieces)
      const length = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      const outward = [Math.sign(signedArea) * (p1[1] - p0[1]) / length, -Math.sign(signedArea) * (p1[0] - p0[0]) / length];
      const probe = [(p0[0] + p1[0]) / 2 + outward[0] * 1e-4, (p0[1] + p1[1]) / 2 + outward[1] * 1e-4];
      if (pieces.some((other, k) => k !== index && insidePiece(probe, other))) {
        return;
      }
      const [y0, y1] = [roofY(p0), roofY(p1)];
      if (Math.max(y0, y1) <= host.wallTopY + 1e-9) {
        return;
      }
      knees.push([[p0[0], host.wallTopY, p0[1]], [p1[0], host.wallTopY, p1[1]], [p1[0], y1, p1[1]], [p0[0], y0, p0[1]]]);
    });
  });
  return polygonsToTriangles(knees);
}

/**
 * A structure's walls, clipped to what shows. They always stand clear of the
 * host roof and any other volume. A structure standing on a base (a porch)
 * also removes the host roof wherever its own roof is above it (its
 * `removedRoof`): there its walls run on down to the host's wall top, since
 * nothing covers them any more; elsewhere the host roof still does.
 */
function standingWalls(triangles, resolved, {
  hostSolids, hostBody, others, clipOutside,
}) {
  const aboveRoof = clipOutside(triangles, [...hostSolids, ...others]);
  if (!resolved.standing) {
    return aboveRoof;
  }
  const underHostRoof = hostSolids.flatMap((solid) => clipInsideConvexSolid(triangles, solid));
  const underRemovedRoof = resolved.removedRoof.flatMap((piece) => clipOutside(
    clipInsideConvexSolid(underHostRoof, planPrism(piece)),
    [hostBody, ...others]
  ));
  return [...aboveRoof, ...underRemovedRoof];
}

/**
 * Whether a structure breaks its host's eave. A flush front wall does, where
 * the host has a wall under the eave and the structure actually reaches
 * that high; a short one (e.g. a ground-level porch set well below the
 * eave, just flush in plan) stands under the eave without touching it, and
 * leaves it whole. A projecting porch does when its walls rise past the
 * host's wall top.
 */
function interruptsHostEave(resolved, host) {
  // a flush wall carries the host's wall up through the eave; where the host
  // is open on that side (a ground porch under a sleeping porch) there is no
  // wall to carry, and the eave runs on as a beam
  if (host.openBoundsSides?.includes(resolved.hostSide)) {
    return false;
  }
  if (resolved.flush) {
    const { frame } = resolved;
    const wall = host.bounds[resolved.hostSide];
    const along = (resolved.along[0] + resolved.along[1]) / 2;
    const [x, z] = frame.along === 'x' ? [along, wall] : [wall, along];
    const top = resolved.planes.length
      ? resolved.plateY + evalZoneHeight(resolved.planes, x, z)
      : resolved.plateY + resolved.slabThickness;
    return top >= host.baseY - 1e-9;
  }
  // A projecting porch breaks the eave only when its walls rise past the
  // host's wall top. Where just its roof rises past the eave, the porch's
  // solid cuts the host eave away where the porch roof is above it, and the
  // two roofs meet in valleys as one shell.
  return resolved.projecting && resolved.plateY >= host.wallTopY - 1e-9;
}

/**
 * A structure that breaks through the host eave (see interruptsHostEave):
 * the host eave (roof edge, fascia, and soffit) stops on either side of it.
 * The eave is cut away across the structure's width, and each cut end is
 * closed with the eave's cross-section (see hostEaveProfile), except where a
 * projecting structure's own side wall already stands across it. Returns the
 * cap triangles, in absolute coordinates.
 */
function interruptHostEave(resolved, host, roofMeshes) {
  const side = resolved.hostSide;
  // nothing to break where no eave runs (an inside stretch of a continuous roof)
  if (!hostEaveProfile(host, side) || !hostEaveCovers(host, side, (resolved.along[0] + resolved.along[1]) / 2)) {
    return [];
  }
  const { frame } = resolved;
  const [a0, a1] = resolved.along;
  const wall = host.bounds[side];
  const axisVector = (axis, value) => (axis === 'x' ? [value, 0, 0] : [0, 0, value]);
  // the eave in front of the structure: within its width, outside the host wall
  const eaveSpan = [
    { normal: axisVector(frame.along, -1), offset: -a0 },
    { normal: axisVector(frame.along, 1), offset: a1 },
    { normal: axisVector(frame.inward, frame.sign), offset: frame.sign * wall },
  ];
  roofMeshes.forEach((mesh) => {
    const y = mesh.position.y;
    const absolute = geometryTriangles(mesh.geometry).map((tri) => tri.map(([px, py, pz]) => [px, py + y, pz]));
    const kept = clipOutsideConvexSolid(absolute, eaveSpan).map((tri) => tri.map(([px, py, pz]) => [px, py - y, pz]));
    mesh.geometry.dispose();
    mesh.geometry = trianglesToGeometry(kept);
  });
  const point = (along, cross, height) => (frame.along === 'x'
    ? [along, host.baseY + height, cross]
    : [cross, host.baseY + height, along]);
  const sides = structureWallSides(frame);
  const wallAt = (end) => Object.keys(sides).find((wallName) => sides[wallName] === `${end}${frame.along.toUpperCase()}`);
  const coveredBySideWall = (end) => resolved.projecting && !resolved.openSides.includes(wallAt(end));
  return polygonsToTriangles([[a0, 'min'], [a1, 'max']]
    .filter(([along, end]) => hostEaveCovers(host, side, along) && !coveredBySideWall(end))
    .map(([along]) => along)
    .map((along) => hostEaveProfile(host, side, along).outline.map(([cross, height]) => point(along, cross, height))));
}

/**
 * A resolved structure's roof and eave trim, in absolute coordinates, built
 * by the same analytic builders as a volume's roof. Its back side (buried in
 * the host roof) gets no overhang; a hip keeps its all-round overhang, since
 * its faces are only planar with equal overhang and its back end drops to
 * its plate, well inside the host. The roof builders close gable ends,
 * shed sides, and the edge of a flat slab with faces at the wall planes;
 * where the structure has a wall there instead, those faces are dropped so
 * walls and roof do not overlap.
 */
function structureRoofTriangles(resolved, config) {
  const sides = structureWallSides(resolved.frame);
  const setup = structureEaveSetup(resolved, config);
  const { bounds } = resolved;
  const roofConfig = {
    roofDirection: resolved.ridgeAxis,
    roofHighEdge: resolved.roofHighEdge,
    roofHeight: resolved.roofHeight,
    roofPitchRise: resolved.roofPitchRise,
    roofPitchRun: resolved.roofPitchRun,
    overhang: setup.overhang,
    eaves: setup.eaves,
  };
  if (resolved.eaveRoof) {
    return [
      ...eaveRoofTriangles(resolved, setup).map((tri) => tri.map(([x, y, z]) => [x, y + resolved.plateY, z])),
      ...openEaveHeaders(resolved, setup),
    ];
  }
  const geometry = resolved.roofType === 'gable'
    ? createGableRoofGeometry(bounds, roofConfig)
    : resolved.roofType === 'hip'
      ? createHipRoofGeometry(bounds, roofConfig)
      : resolved.roofType === 'shed'
        ? createShedRoofGeometry(bounds, roofConfig)
        : createFlatRoofGeometry(bounds, setup.overhang);
  let triangles = geometryTriangles(geometry).map((tri) => tri.map(([x, y, z]) => [x, y + resolved.plateY, z]));
  geometry.dispose();
  if (resolved.roofType === 'flat' && resolved.openSides.length === 0) {
    // the slab's underside is only seen as a soffit under its overhang; inside closed walls it is hidden
    const underside = (tri) => tri.every((v) => Math.abs(v[1] - resolved.plateY) < 1e-6);
    const insideWalls = [
      { normal: [-1, 0, 0], offset: -bounds.minX }, { normal: [1, 0, 0], offset: bounds.maxX },
      { normal: [0, 0, -1], offset: -bounds.minZ }, { normal: [0, 0, 1], offset: bounds.maxZ },
    ];
    triangles = [
      ...triangles.filter((tri) => !underside(tri)),
      ...clipOutsideConvexSolid(triangles.filter(underside), insideWalls),
    ];
  }
  const wallPlanes = ['front', 'back', 'left', 'right']
    .filter((wall) => !resolved.openSides.includes(wall))
    .map((wall) => sides[wall]);
  const inWallPlane = (tri) => wallPlanes.some((side) => {
    const k = side === 'minX' || side === 'maxX' ? 0 : 2;
    return tri.every((v) => Math.abs(v[k] - bounds[side]) < 1e-6 && v[1] >= resolved.plateY - 1e-6);
  });
  return [...triangles.filter((tri) => !inWallPlane(tri)), ...openEaveHeaders(resolved, setup)];
}

/** Overhang and eave settings for a structure's roof: no overhang on its buried back side. */
function structureEaveSetup(resolved, config) {
  const sides = structureWallSides(resolved.frame);
  const eaveConfig = {
    ...pickEaveConfig(config),
    volumeEaves: { ...(config.volumeEaves ?? {}), [resolved.id]: resolved.eaves ?? {} },
  };
  const setup = volumeEaveSetup(
    resolved.id,
    resolved.roofType,
    { ridgeAxis: resolved.ridgeAxis, roofHighEdge: resolved.roofHighEdge },
    eaveConfig,
    resolved.roofType === 'hip' || resolved.through ? [] : [sides.back],
    undefined,
    resolved.bounds
  );
  if (resolved.eaveRoof) {
    // a wraparound overhangs only its outer eaves: not at its walls or where its segments meet
    const depth = Math.max(0, ...resolved.eaveRoof.eaveSides.map((side) => setup.overhang?.[side] ?? 0));
    setup.overhang = Object.fromEntries(['minX', 'maxX', 'minZ', 'maxZ']
      .map((side) => [side, resolved.eaveRoof.eaveSides.includes(side) ? depth : 0]));
  }
  return setup;
}

/**
 * A wraparound segment's roof (see joinWrapRoofs): its shared planes over its
 * rectangle carried out over its eaves, face by face, with a fascia and
 * soffit along each eave. Heights are above the plate.
 */
function eaveRoofTriangles(resolved, setup) {
  const { bounds } = resolved;
  const overhang = setup.overhang;
  const outer = {
    minX: bounds.minX - overhang.minX, maxX: bounds.maxX + overhang.maxX, minZ: bounds.minZ - overhang.minZ, maxZ: bounds.maxZ + overhang.maxZ,
  };
  const slope = resolved.planes[0]?.slope ?? 0;
  const fascia = setup.eaves.fasciaDepth ?? 0;
  const corners = (box) => [[box.minX, box.minZ], [box.maxX, box.minZ], [box.maxX, box.maxZ], [box.minX, box.maxZ]];
  const [outerCorners, innerCorners] = [corners(outer), corners(bounds)];
  const trim = [];
  ['minZ', 'maxX', 'maxZ', 'minX'].forEach((side, i) => {
    const depth = overhang[side];
    if (depth <= 1e-9) {
      return;
    }
    const j = (i + 1) % 4;
    const y = -slope * depth;
    const [o0, o1, w0, w1] = [outerCorners[i], outerCorners[j], innerCorners[i], innerCorners[j]];
    trim.push(
      [[o0[0], y, o0[1]], [o1[0], y, o1[1]], [o1[0], y - fascia, o1[1]]],
      [[o0[0], y, o0[1]], [o1[0], y - fascia, o1[1]], [o0[0], y - fascia, o0[1]]],
    );
    const inner = setup.eaves.eaveSoffit === 'sloped' ? -fascia : y - fascia;
    trim.push(
      [[w0[0], inner, w0[1]], [w1[0], inner, w1[1]], [o1[0], y - fascia, o1[1]]],
      [[w0[0], inner, w0[1]], [o1[0], y - fascia, o1[1]], [o0[0], y - fascia, o0[1]]],
    );
  });
  // a plain end (a shed's, or one against a wall) is closed from the plate up
  // to the roof; against a wall the wall's solid clips it away
  const walls = structureWallSides(resolved.frame);
  const seams = (resolved.seamSides ?? []).map((wall) => walls[wall]);
  const ends = ['minX', 'maxX', 'minZ', 'maxZ'].filter((side) => overhang[side] <= 1e-9 && !seams.includes(side)).map((side) => {
    const [a, b] = side === 'minX' || side === 'maxX'
      ? [[bounds[side], bounds.minZ], [bounds[side], bounds.maxZ]]
      : [[bounds.minX, bounds[side]], [bounds.maxX, bounds[side]]];
    const top = roofProfile(resolved.planes, a, b).reverse()
      .map(([t, height]) => [a[0] + (b[0] - a[0]) * t, height, a[1] + (b[1] - a[1]) * t]);
    return [[a[0], 0, a[1]], [b[0], 0, b[1]], ...top];
  });
  // an eave running out to a plain end is capped there with its cross-section
  const order = ['minZ', 'maxX', 'maxZ', 'minX'];
  const caps = order.flatMap((side, i) => {
    const depth = overhang[side];
    if (depth <= 1e-9) {
      return [];
    }
    const y = -slope * depth;
    const inner = setup.eaves.eaveSoffit === 'sloped' ? -fascia : y - fascia;
    const outward = side.startsWith('min') ? -depth : depth;
    return [order[(i + 3) % 4], order[(i + 1) % 4]]
      .filter((end) => overhang[end] <= 1e-9 && !seams.includes(end))
      .map((end) => {
        const at = (across, height) => (side === 'minX' || side === 'maxX'
          ? [across, height, bounds[end]]
          : [bounds[end], height, across]);
        const wall = bounds[side];
        return [at(wall, 0), at(wall + outward, y), at(wall + outward, y - fascia), at(wall, inner)];
      });
  });
  return [...minOfPlanesFaces(outer, resolved.planes), ...trim, ...polygonsToTriangles([...ends, ...caps])];
}

/**
 * Where a side of a structure with an overhang is open (a porch), the
 * soffit would end in mid-air at the wall line; a header closes it, from the
 * soffit up to the plate, along the open side. Above the plate a gable or
 * shed side keeps the roof's own closing face.
 */
function openEaveHeaders(resolved, setup) {
  const sides = structureWallSides(resolved.frame);
  const { bounds, plateY } = resolved;
  const fascia = setup.eaves.fasciaDepth ?? 0;
  const soffitDepth = (plane) => {
    const depth = setup.overhang?.[plane.side] ?? 0;
    if (depth <= 1e-9) {
      return 0;
    }
    return setup.eaves.eaveSoffit === 'sloped' ? fascia : plane.slope * depth + fascia;
  };
  // under a rake, the deepest eave box it meets at the corners
  const rakeDepth = Math.max(fascia, ...resolved.planes.map(soffitDepth));
  return resolved.openSides.filter((wallName) => !resolved.seamSides?.includes(wallName)).flatMap((wallName) => {
    const side = sides[wallName];
    if ((setup.overhang?.[side] ?? 0) <= 1e-9) {
      return [];
    }
    const plane = resolved.planes.find((candidate) => candidate.side === side);
    const bottom = plateY - (plane ? soffitDepth(plane) : rakeDepth);
    const [a, b] = side === 'minX' || side === 'maxX'
      ? [[bounds[side], bounds.minZ], [bounds[side], bounds.maxZ]]
      : [[bounds.minX, bounds[side]], [bounds.maxX, bounds[side]]];
    return polygonsToTriangles([[[a[0], bottom, a[1]], [b[0], bottom, b[1]], [b[0], plateY, b[1]], [a[0], plateY, a[1]]]]);
  });
}

/**
 * Build independent massing per volume when at least one volume has a story
 * count that diverges from the building default (Task 9). Each volume gets
 * its own box walls, foundation, and an analytic hip/gable/flat roof sized to
 * its own rectangle and elevated to its own wall-top height. The roof ridge
 * for each volume follows that volume's own longitudinal axis, so a lean-to
 * or wing naturally gets a ridge perpendicular to the main block's.
 *
 * This does not yet trim/miter roof planes where volumes of equal height
 * meet (unlike the single-field surface used when no overrides are set);
 * adjacent equal-height volumes will show independent roof edges meeting at
 * the shared wall rather than a blended valley.
 */
function createMultiVolumeBuilding(volumes, overrides, config) {
  const {
    storyCount, storyHeight, foundationDepth, roofEaveDepth, roofType, roofHeight, roofPitchRise, roofPitchRun,
  } = config;
  const directedVolumes = applyVolumeRidgeDirections(volumes, config.volumeRidgeDirections ?? {});
  const hasGableVolume = directedVolumes.some((volume) => ['gable', 'gambrel'].includes(config.volumeRoofTypes?.[volume.id] ?? roofType));
  const roofVolumes = hasGableVolume
    ? resolveGableRidgeDirections(directedVolumes)
    : directedVolumes;
  const materials = createMaterials(config);
  const group = new THREE.Group();
  const foundationHeight = foundationDepth;
  let maxTotalHeight = 0;
  const roofZones = [];
  const heightConfig = { ...config, volumeStoryOverrides: overrides };
  const wallHeights = Object.fromEntries(roofVolumes.map((volume) => [volume.id, volumeWallHeight(volume.id, heightConfig)]));
  const foundations = Object.fromEntries(roofVolumes.map((volume) => [volume.id, volumeFoundationHeight(volume.id, heightConfig)]));
  // each volume's plate above grade: how its roof meets its neighbors' depends on these
  const volumePlateHeights = Object.fromEntries(roofVolumes.map((volume) => [volume.id, foundations[volume.id] + wallHeights[volume.id]]));
  const connections = resolveRoofConnections(roofVolumes, { ...config, volumePlateHeights });
  const adjacentSides = adjacentSidesByVolume(roofVolumes, volumePlateHeights);
  const setups = buildRoofSetups(roofVolumes, config, connections, adjacentSides, (volume) => config.volumeRoofTypes?.[volume.id] ?? roofType);

  roofVolumes.forEach((volume) => {
    const totalHeight = wallHeights[volume.id];
    const volumeFoundation = foundations[volume.id];
    maxTotalHeight = Math.max(maxTotalHeight, totalHeight);
    const roofTypeForVolume = config.volumeRoofTypes?.[volume.id] ?? roofType;
    const volumeConnections = connections.get(volume.id);
    const { bounds, extendedRoofHeight } = applyRoofExtension(
      { minX: volume.minX, maxX: volume.maxX, minZ: volume.minZ, maxZ: volume.maxZ },
      roofTypeForVolume,
      volumeConnections
    );
    const wallBounds = { minX: volume.minX, maxX: volume.maxX, minZ: volume.minZ, maxZ: volume.maxZ };

    addVolumeBody(group, volume, {
      floorY: volumeFoundation, topY: volumeFoundation + totalHeight, config: heightConfig, materials,
    });

    const roofDirectionForVolume = volume.ridgeAxis;
    const params = volumeRoofParams(volume.id, halfSpanForBounds(wallBounds, roofDirectionForVolume), config);
    const setup = setups.get(volume.id);
    const roofHeightForVolume = roofTypeForVolume === 'flat'
      ? 0
      : (extendedRoofHeight ?? params.roofHeight);
    const roofConfig = {
      roofDirection: roofDirectionForVolume,
      roofHighEdge: volume.roofHighEdge ?? defaultHighEdgeForAxis(roofDirectionForVolume),
      roofHeight: roofHeightForVolume,
      overhang: setup.overhang,
      eaves: setup.eaves,
      abut: eaveAbutments(volumeConnections, setups, volumePlateHeights, volume.id),
      roofPitchRise: params.pitchRise,
      roofPitchRun: params.pitchRun,
      connections: volumeConnections,
    };
    if (roofTypeForVolume === 'gable') {
      const gableMerge = gableMergeGeometry(volume, bounds, volumeConnections, roofHeightForVolume);
      if (gableMerge.any) {
        roofConfig.roofHeight = gableMerge.roofHeight;
        roofConfig.ridgeEndpoints = gableMerge.endpoints;
        roofConfig.mergedEnds = gableMerge.mergedEnds;
      }
    }
    if (roofTypeForVolume === 'hip') {
      Object.assign(roofConfig, withHipWalk(roofConfig, volume.id, config));
    }
    if (isTwoSlope(roofTypeForVolume)) {
      const unsloped = unslopedSidesOf(adjacentSides.get(volume.id), volume);
      Object.assign(roofConfig, withTwoSlope(roofConfig, volume.id, roofTypeForVolume, config, bounds, unsloped), {
        roofType: roofTypeForVolume,
        neighborSolids: neighborSolidsForEnds(volume, unsloped, roofVolumes, config, adjacentSides, (id) => volumePlateHeights[id] ?? 0),
      });
    }
    if (volume.outline) {
      // cut by angled walls (see js/cut-roofs.js)
      const cut = createCutVolumeRoof(volume, roofTypeForVolume, config, { setup, roofConfig, sharedEdge: sharedEdgeTest(volume, roofVolumes) });
      const roof = new THREE.Mesh(flatShaded(clipInsideNeighbor(cut.geometry, volumeConnections)), materials.roof);
      roof.position.y = volumeFoundation + totalHeight + ROOF_LIFT;
      roofZones.push(...cut.zones.map((zone) => ({
        ...zone, baseY: roof.position.y, wallTopY: volumeFoundation + totalHeight, foundationTopY: volumeFoundation,
      })));
      roof.userData = {
        volumeId: volume.id, roofType: roofTypeForVolume, roofDirection: roofDirectionForVolume, roofHeight: roofHeightForVolume,
        roofPitch: { rise: params.pitchRise, run: params.pitchRun, degrees: roofPitchDegrees(params.pitchRise, params.pitchRun) },
      };
      group.add(roof);
      return;
    }
    const roofGeometry = isTwoSlope(roofTypeForVolume)
      ? createTwoSlopeRoofGeometry(bounds, roofConfig)
      : roofTypeForVolume === 'gable'
      ? createGableRoofGeometry(bounds, roofConfig)
      : roofTypeForVolume === 'hip'
        ? createHipRoofGeometry(bounds, roofConfig)
        : roofTypeForVolume === 'shed'
          ? createShedRoofGeometry(bounds, roofConfig)
        : createFlatRoofGeometry(bounds, setup.overhang);
    const roof = new THREE.Mesh(flatShaded(clipInsideNeighbor(roofGeometry, volumeConnections)), materials.roof);
    roof.position.y = volumeFoundation + totalHeight + ROOF_LIFT;
    roofZones.push({
      ...roofZoneDescriptor(volume.id, {
        wallBounds,
        roofBounds: bounds,
        roofType: roofTypeForVolume,
        roofConfig,
        setup,
        exact: !hasCoplanarShedMerge(roofTypeForVolume, volumeConnections),
      }),
      baseY: roof.position.y,
      wallTopY: volumeFoundation + totalHeight,
      foundationTopY: volumeFoundation,
    });
    roof.userData = {
      volumeId: volume.id,
      roofType: roofTypeForVolume,
      roofDirection: roofDirectionForVolume,
      roofHeight: roofHeightForVolume,
      roofPitch: {
        rise: params.mode === 'height' ? roofHeightForVolume : params.pitchRise,
        run: params.mode === 'height' ? params.pitchRun : params.pitchRun,
        degrees: roofPitchDegrees(params.pitchRise, params.pitchRun),
      },
    };
    group.add(roof);
  });

  // an eave run on over a lower neighbor is cut where the neighbor's roof passes through it,
  const zonesById = new Map(roofZones.map((zone) => [zone.volumeId, zone]));
  group.children.filter((child) => child.isMesh && child.userData?.roofType && child.userData.volumeId).forEach((roof) => {
    // and where a gable merging into it runs up through its eave
    const own = roofVolumes.find((volume) => volume.id === roof.userData.volumeId);
    const lower = new Set([
      ...[...(adjacentSides.get(roof.userData.volumeId)?.values() ?? [])].flat().filter((link) => link.below).map((link) => link.neighborId),
      ...mergingNeighbors(roof.userData.volumeId, connections),
      // a cut roof's walls and eaves stop at its neighbors (see createVolumeRoofAssembly)
      ...(own?.outline ? neighborIds(own, roofVolumes) : []),
    ]);
    if (!lower.size) {
      return;
    }
    const y = roof.position.y;
    let triangles = geometryTriangles(roof.geometry).map((tri) => tri.map(([px, py, pz]) => [px, py + y, pz]));
    lower.forEach((id) => {
      triangles = clipOutsideConvexSolid(triangles, volumeSolid(zonesById.get(id)));
    });
    roof.geometry.dispose();
    roof.geometry = flatShaded(trianglesToGeometry(triangles.map((tri) => tri.map(([px, py, pz]) => [px, py - y, pz]))));
  });

  cutPassages(group, roofVolumes, materials);
  group.userData = { ...group.userData, multiVolume: true, volumeCount: volumes.length };
  return {
    building: group, foundationHeight, totalHeight: maxTotalHeight, roofZones,
  };
}

/**
 * Resolves the roof shape parameters for one volume. A volume can override
 * the building-wide roof shape with its own pitch (`{ mode: 'slope',
 * pitchRise }`) or fixed roof rise (`{ mode: 'height', height }`) via
 * `config.volumeRoofShapes`; everything else follows the building defaults.
 * `halfSpan` is the volume's own half-width across its ridge.
 */
function volumeRoofParams(volumeId, halfSpan, config) {
  const shape = config.volumeRoofShapes?.[volumeId];
  const mode = shape?.mode ?? config.roofHeightMode ?? 'slope';
  const pitchRun = config.roofPitchRun ?? 12;
  if (mode === 'height') {
    const height = shape?.mode === 'height' ? shape.height : (config.roofHeight ?? 2);
    return { mode, roofHeight: height, pitchRise: height, pitchRun: halfSpan };
  }
  const pitchRise = shape?.mode === 'slope' ? shape.pitchRise : (config.roofPitchRise ?? 6);
  return { mode, roofHeight: halfSpan * (pitchRise / pitchRun), pitchRise, pitchRun };
}

/**
 * The resolved roof of one volume, as built: its wall rectangle, the
 * rectangle its roof planes are defined over (a shed extended to a ridge
 * reaches past its walls), and its final planes after any merge (a merged
 * gable's lowered ridge, a shed's snapped slope). Roof structures use it to
 * build the volume's solid (`volumeSolid` in js/roof-structures.js) without
 * reading the mesh. Planes are in the roof's own frame (height above the
 * plate); `baseY` is the plate's absolute elevation and `wallTopY` the top
 * of the walls just below it (roofs sit ROOF_LIFT above their walls), both
 * filled in by the caller that positions the roof mesh.
 *
 * `exact` is false where the rendered surface is not the min of these planes:
 * a hip whose ridge ends were moved to meet a neighbor's, or a shed corner
 * clamped onto a neighbor's plane by a coplanar merge.
 */
function roofZoneDescriptor(volumeId, {
  wallBounds, roofBounds, roofType, roofConfig, setup, exact = true,
}) {
  const roofHeight = roofType === 'flat' ? 0 : roofConfig.roofHeight;
  const roofHighEdge = roofType === 'shed' ? shedHighEdge(roofConfig) : roofConfig.roofHighEdge;
  const planes = computeVolumeEavePlanes(roofBounds, roofType, { ...roofConfig, roofHighEdge });
  if (roofType === 'hip' && planes.length && roofHeight < evalZoneHeight(planes, (roofBounds.minX + roofBounds.maxX) / 2, (roofBounds.minZ + roofBounds.maxZ) / 2) - 1e-6) {
    // a hip's ridge sits at its configured height even when the pitch alone would peak higher
    planes.push({ constantHeight: roofHeight });
  }
  return {
    volumeId,
    roofType,
    bounds: wallBounds,
    roofBounds,
    ridgeAxis: roofConfig.roofDirection,
    roofHighEdge,
    roofHeight,
    planes,
    slabThickness: roofType === 'flat' ? FLAT_ROOF_THICKNESS : 0,
    overhang: setup?.overhang,
    eaves: setup?.eaves,
    exact,
    baseY: 0,
    wallTopY: 0,
  };
}

/** Whether a shed's corners were clamped onto a neighbor's plane rather than its own. */
function hasCoplanarShedMerge(roofType, connections) {
  return roofType === 'shed' && Object.values(connections ?? {}).some((resolution) => (
    resolution?.mode === 'merged' && !resolution.override && !resolution.rakeTriangle
  ));
}

/**
 * A ridge-snap connection (see resolveRoofConnections) physically relocates
 * a shed's boundary on that side out to the neighbor's actual ridge
 * coordinate — not just a taller corner within the same rectangle — so the
 * shed's own roof plane genuinely runs from its far eave to the neighbor's
 * ridge, the way a real saltbox's rear slope does.
 */
function applyRoofExtension(bounds, roofType, connections) {
  let extended = bounds;
  let extendedRoofHeight;
  if (roofType === 'shed' && connections) {
    Object.entries(connections).forEach(([side, resolution]) => {
      if (resolution.extendTo !== undefined) {
        extended = { ...extended, [side]: resolution.extendTo };
        extendedRoofHeight = resolution.height;
      } else if (resolution.rakeTriangle) {
        extendedRoofHeight = resolution.height;
      }
    });
  }
  return { bounds: extended, extendedRoofHeight };
}

// Indexed roof builders share vertices between differently-oriented faces, so
// computeVertexNormals smooths across them and steep closure faces shade
// wrongly (near-black). Unrolling to per-face vertices gives flat shading.
function flatShaded(geometry) {
  return mergeFlatGeometries([geometry]);
}

function roofHeightForBounds(bounds, roofDirection, pitchRise, pitchRun) {
  return halfSpanForBounds(bounds, roofDirection) * (pitchRise / pitchRun);
}

function halfSpanForBounds(bounds, roofDirection) {
  const span = roofDirection === 'x' ? (bounds.maxZ - bounds.minZ) : (bounds.maxX - bounds.minX);
  return Math.max(0.01, span / 2);
}

/** A volume's walls: its rectangle, or its outline where angled walls cut it, extruded up `depth`. */
function createBoxWallGeometry(bounds, depth, outline) {
  const shape = new THREE.Shape();
  const corners = outline ?? [[bounds.minX, bounds.minZ], [bounds.maxX, bounds.minZ], [bounds.maxX, bounds.maxZ], [bounds.minX, bounds.maxZ]];
  corners.forEach(([x, z], i) => (i === 0 ? shape.moveTo(x, -z) : shape.lineTo(x, -z)));
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: false, steps: 1, curveSegments: 1,
  });
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

export function getRoofRun(footprint, roofDirection = 'z', volumes = [], roofType) {
  roofDirection = roofAxisForDirection(roofDirection);
  if (volumes.length > 1) {
    if (straightSkeletonBuilder) {
      const ring = footprint.map(([x, z]) => [x, z]);
      ring.push([...ring[0]]);
      const skeleton = straightSkeletonBuilder.buildFromPolygon([ring]);
      if (skeleton) {
        return Math.max(...skeleton.vertices.map(([, , time]) => time), 0.01);
      }
    }
    return Math.max(...volumes.map((volume) => halfSpanForBounds(volume, volume.ridgeAxis)));
  }
  const xValues = footprint.map(([x]) => x);
  const zValues = footprint.map(([, z]) => z);
  const xHalf = (Math.max(...xValues) - Math.min(...xValues)) / 2;
  const zHalf = (Math.max(...zValues) - Math.min(...zValues)) / 2;
  // A hip's four faces only share one pitch when its height is set by the
  // shorter of the two spans (the one that actually controls the ridge/apex),
  // whichever axis the ridge direction is configured to run along -- picking
  // the span across the configured direction alone leaves the hip-end faces
  // steeper or shallower than the configured pitch whenever that direction
  // isn't already the footprint's longer axis.
  const span = roofType === 'hip'
    ? 2 * Math.min(xHalf, zHalf)
    : (roofDirection === 'x' ? 2 * zHalf : 2 * xHalf);
  return Math.max(0.01, span / 2);
}

export function roofHeightFromPitch(footprint, roofDirection, pitchRise, pitchRun = 12, volumes = [], roofType) {
  return (pitchRise / pitchRun) * getRoofRun(footprint, roofDirection, volumes, roofType);
}

export function roofPitchFromHeight(footprint, roofDirection, roofHeight, pitchRun = 12, volumes = [], roofType) {
  return (roofHeight / getRoofRun(footprint, roofDirection, volumes, roofType)) * pitchRun;
}

export function roofPitchDegrees(pitchRise, pitchRun = 12) {
  return THREE.MathUtils.radToDeg(Math.atan(pitchRise / pitchRun));
}

/**
 * The roof mesh for the whole footprint, plus a resolved zone descriptor per
 * volume (see roofZoneDescriptor) wherever an analytic per-volume builder
 * produced it. The straight-skeleton hip, the sampled roof field, and the flat
 * cap over a non-rectangular footprint have no per-volume planes, so they
 * return no zones.
 *
 * @returns {{ geometry: THREE.BufferGeometry, zones: Array<object> }}
 */
function createRoofGeometry(footprint, config) {
  const roofHighEdge = config.roofHighEdge ?? config.roofDirection;
  config = {
    ...config,
    roofDirection: roofAxisForDirection(config.roofDirection),
    roofHighEdge,
  };
  const bounds = getRectangularBounds(footprint);
  if (bounds && config.roofType === 'hip' && !(config.volumes?.length > 1)) {
    // A hip's four faces only share one pitch when its ridge runs along the
    // footprint's longer axis -- the configured alignment only picks a side,
    // not a wrong axis, so a short-axis choice is corrected to the matching
    // long-axis one rather than left to produce a mismatched pitch.
    const longAxis = (bounds.maxZ - bounds.minZ) >= (bounds.maxX - bounds.minX) ? 'z' : 'x';
    if (config.roofDirection !== longAxis) {
      const side = String(config.roofHighEdge ?? '').endsWith('max') ? 'max' : 'min';
      config = { ...config, roofDirection: longAxis, roofHighEdge: `${longAxis}-${side}` };
    }
  }
  const hasSlopedVolumeRoof = config.volumes?.some((volume) => {
    const roofType = config.volumeRoofTypes?.[volume.id] ?? config.roofType;
    return roofType === 'gable' || roofType === 'hip' || roofType === 'shed' || isTwoSlope(roofType);
  });
  const rectangleVolumeId = config.volumes?.[0]?.id ?? 'volume-main';
  const rectangleSetup = bounds
    ? volumeEaveSetup(rectangleVolumeId, config.roofType, { ridgeAxis: config.roofDirection, roofHighEdge: config.roofHighEdge }, config)
    : null;
  const rectangleZone = (roofType, roofConfig) => [roofZoneDescriptor(rectangleVolumeId, {
    wallBounds: bounds, roofBounds: bounds, roofType, roofConfig, setup: rectangleSetup,
  })];
  const cutVolume = config.volumes?.length === 1 && config.volumes[0].outline ? config.volumes[0] : null;
  if (cutVolume) {
    return createCutVolumeRoof(cutVolume, config.roofType, config);
  }
  if (bounds && config.roofType === 'flat') {
    return { geometry: createFlatRoofGeometry(bounds, rectangleSetup.overhang), zones: rectangleZone('flat', config) };
  }

  const hasVolumeShapeOverride = Object.keys(config.volumeRoofShapes ?? {}).length > 0
    && config.volumes?.length > 1;
  if (hasVolumeShapeOverride && (config.roofType !== 'flat' || hasSlopedVolumeRoof)) {
    return createVolumeRoofAssembly(config.volumes, config);
  }
  if (config.roofType === 'gable' || config.roofType === 'hip' || config.roofType === 'shed' || isTwoSlope(config.roofType) || hasSlopedVolumeRoof) {
    if (bounds && isTwoSlope(config.roofType)) {
      const shapedConfig = withTwoSlope(
        { ...config, overhang: rectangleSetup.overhang, eaves: rectangleSetup.eaves },
        rectangleVolumeId, config.roofType, config, bounds, []
      );
      return { geometry: flatShaded(createTwoSlopeRoofGeometry(bounds, shapedConfig)), zones: rectangleZone(config.roofType, shapedConfig) };
    }
    if (bounds) {
      const shapedConfig = config.roofType === 'hip'
        ? withHipWalk({ ...config, overhang: rectangleSetup.overhang, eaves: rectangleSetup.eaves }, rectangleVolumeId, config)
        : { ...config, overhang: rectangleSetup.overhang, eaves: rectangleSetup.eaves };
      const geometry = flatShaded(config.roofType === 'gable'
        ? createGableRoofGeometry(bounds, shapedConfig)
        : config.roofType === 'hip'
          ? createHipRoofGeometry(bounds, shapedConfig)
          : createShedRoofGeometry(bounds, shapedConfig));
      return { geometry, zones: rectangleZone(config.roofType, shapedConfig) };
    }
    if (config.roofType === 'hip'
      && config.roofHeightMode === 'height'
      && config.volumes
      && config.volumes.length > 1) {
      return createVolumeRoofAssembly(config.volumes, config);
    }
    if (config.roofType === 'hip' && config.volumes && config.volumes.length > 1 && straightSkeletonBuilder) {
      const topology = createStraightSkeletonHipGeometry(footprint, config);
      if (topology) {
        return {
          geometry: topology.geometry,
          zones: skeletonHipZones(config.volumes, topology),
          walks: topology.walk ? [{ id: 'roof-walk-main', volumeIds: (config.volumes ?? []).map((volume) => volume.id), ...topology.walk }] : [],
        };
      }
    }
    if (config.roofType === 'hip'
      && config.volumes
      && config.volumes.length > 1) {
      // (the skeleton library fails on some symmetric angled outlines: each volume its own hip then)
      if (config.volumes.some((volume) => volume.outline)) {
        return createVolumeRoofAssembly(config.volumes, config);
      }
      return { geometry: createRoofFieldSurface(footprint, config), zones: [] };
    }
    if (config.volumes && config.volumes.length > 1) {
      return createVolumeRoofAssembly(config.volumes, config);
    }
    return { geometry: createRoofFieldSurface(footprint, config), zones: [] };
  }

  // a flat roof over several volumes: one slab over the whole footprint, with
  // no overhang, and a zone per volume for structures to stand on
  const roofShape = buildShape(footprint, 0);
  const geometry = new THREE.ExtrudeGeometry(roofShape, {
    depth: FLAT_ROOF_THICKNESS,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 12,
  });
  geometry.rotateX(-Math.PI / 2);
  const noOverhang = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  const zones = (config.volumes ?? []).map((volume) => {
    const bounds = { minX: volume.minX, maxX: volume.maxX, minZ: volume.minZ, maxZ: volume.maxZ };
    const zone = roofZoneDescriptor(volume.id, {
      wallBounds: bounds,
      roofBounds: bounds,
      roofType: 'flat',
      roofConfig: { ...config, roofDirection: volume.ridgeAxis },
      setup: { overhang: noOverhang, eaves: { ...resolveVolumeEaves(volume.id, config), eaveDepth: 0, rakeDepth: 0 } },
    });
    return volume.outline ? { ...zone, outline: volume.outline } : zone;
  });
  return { geometry, zones };
}

/** Whether a wall a-b of `volume` lies against another of `volumes` (a wall they share). */
function sharedEdgeTest(volume, volumes) {
  const shared = findVolumeAdjacencies(volumes).flatMap((adjacency) => [
    adjacency.volumeAId === volume.id && { side: adjacency.sideA, min: adjacency.overlapMin, max: adjacency.overlapMax },
    adjacency.volumeBId === volume.id && { side: adjacency.sideB, min: adjacency.overlapMin, max: adjacency.overlapMax },
  ].filter(Boolean));
  return (a, b) => shared.some(({ side, min, max }) => {
    const [k, along] = side === 'minX' || side === 'maxX' ? [0, 1] : [1, 0];
    return [a, b].every((point) => Math.abs(point[k] - volume[side]) < 1e-6
      && point[along] >= min - 1e-6 && point[along] <= max + 1e-6);
  });
}

/**
 * The roof of a volume cut by angled walls (see js/cut-roofs.js), with the
 * volume's own eave setup, and its zone: the cut's planes over its outline.
 */
function createCutVolumeRoof(volume, roofType, config, { setup: givenSetup, roofConfig: givenConfig, sharedEdge } = {}) {
  const orientation = { ridgeAxis: config.roofDirection, roofHighEdge: roofType === 'shed' ? shedHighEdge(config) : config.roofHighEdge };
  const setup = givenSetup ?? volumeEaveSetup(volume.id, roofType, orientation, config);
  const bounds = { minX: volume.minX, maxX: volume.maxX, minZ: volume.minZ, maxZ: volume.maxZ };
  let roofConfig = givenConfig ?? { ...config, overhang: setup.overhang, eaves: setup.eaves };
  if (!givenConfig && roofType === 'hip') {
    roofConfig = withHipWalk(roofConfig, volume.id, config);
  } else if (!givenConfig && isTwoSlope(roofType)) {
    roofConfig = withTwoSlope(roofConfig, volume.id, roofType, config, bounds, []);
  }
  if (roofType === 'shed') {
    roofConfig = { ...roofConfig, roofHighEdge: givenConfig ? shedHighEdge(givenConfig) : orientation.roofHighEdge };
  }
  const { triangles, planes } = buildCutRoof(volume, roofType, { ...roofConfig, roofType }, { sharedEdge });
  const zone = roofZoneDescriptor(volume.id, {
    wallBounds: bounds, roofBounds: bounds, roofType, roofConfig, setup,
  });
  return {
    geometry: trianglesToGeometry(triangles),
    zones: [{ ...zone, planes, outline: volume.outline }],
  };
}

function createStraightSkeletonHipGeometry(footprint, config) {
  // The skeleton of the footprint pushed out to the eave line: its faces are
  // the roof's, carried on past the walls at the pitch, so the roof meets the
  // walls at the plate (height 0) and ends at the eave below it.
  const eaves = resolveVolumeEaves(null, { ...config, roofEaveDepth: config.roofEaveDepth ?? config.roofOverhang });
  const overhang = eaves.eaveDepth > 1e-9 ? eaves.eaveDepth : 0;
  const outline = overhang ? offsetRectilinear(footprint, overhang) : footprint.map(([x, z]) => [x, z]);
  const ring = outline.map(([x, z]) => [x, z]);
  ring.push([...ring[0]]);
  const raw = straightSkeletonBuilder.buildFromPolygon([ring]);
  if (!raw) {
    return null;
  }
  const skeleton = snapSkeleton(raw, outline);

  const pitchRatio = (config.roofPitchRise ?? 6) / (config.roofPitchRun ?? 12);
  const eaveY = -pitchRatio * overhang;
  const heightOf = (time) => time * pitchRatio + eaveY;
  const peak = Math.max(0, ...skeleton.vertices.map(([, , time]) => heightOf(time)));
  // a widow's walk cuts the whole roof flat at one height
  const walkHeight = skeletonWalkHeight(config);
  const cut = walkHeight !== undefined && walkHeight < peak - 1e-9 ? walkHeight : undefined;
  const positions = [];
  const addPolygon = (polygon) => {
    if (polygon.length < 3) {
      return;
    }
    const triangles = THREE.ShapeUtils.triangulateShape(polygon.map(([x, , z]) => new THREE.Vector2(x, z)), []);
    triangles.forEach((triangle) => triangle.forEach((index) => positions.push(...polygon[index])));
  };
  // each skeleton face rises at the pitch from one footprint edge: the two of
  // its corners at height zero
  const faces = [];
  const walkPieces = [];
  const walkEdges = [];

  skeleton.polygons.forEach((indices) => {
    const polygon = indices.map((index) => {
      const [x, z, time] = skeleton.vertices[index];
      return [x, heightOf(time), z];
    });
    const base = polygon.filter((point) => point[1] < eaveY + 1e-9);
    let below = polygon;
    if (cut !== undefined) {
      below = clipPolygon(polygon, (v) => cut - v[1]);
      const above = clipPolygon(polygon, (v) => v[1] - cut).map(([x, , z]) => [x, cut, z]);
      if (above.length >= 3) {
        walkPieces.push(above);
      }
      // where this face meets the walk: its edge along the cut
      below.forEach((point, i) => {
        const next = below[(i + 1) % below.length];
        if (Math.abs(point[1] - cut) < 1e-9 && Math.abs(next[1] - cut) < 1e-9
          && Math.hypot(next[0] - point[0], next[2] - point[2]) > 1e-6) {
          walkEdges.push([[point[0], point[2]], [next[0], next[2]]]);
        }
      });
    }
    if (base.length === 2) {
      faces.push({ edge: base.map((point) => [point[0], point[2]]), polygon: below });
    }
    addPolygon(below);
  });
  walkPieces.forEach(addPolygon);
  if (overhang) {
    skeletonEaveTrim(footprint, outline, eaveY, eaves).forEach((triangle) => triangle.forEach((vertex) => positions.push(...vertex)));
  }

  if (positions.length === 0) {
    return null;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  const walk = cut === undefined ? null : {
    height: cut, pieces: walkPieces.map((piece) => piece.map(([x, , z]) => [x, z])), edges: walkEdges,
  };
  return {
    geometry, faces, pitchRatio, walk, walkFaces: walkPieces, overhang, eaves,
  };
}

/**
 * The skeleton library works in single precision, so its nodes are off by
 * about 1e-6 (20.2 comes back as 20.2000008). On a rectilinear outline every
 * node lies at an outline coordinate plus or minus half the gap between two
 * outline coordinates, so each is snapped to the nearest such value, and its
 * time (height over the pitch) recomputed as its distance from the base edge
 * of a face it belongs to. Faces from different skeleton polygons then meet
 * exactly, as the plain footprint's did.
 */
function snapSkeleton(skeleton, outline) {
  const xs = [...new Set(outline.map(([x]) => x))];
  const zs = [...new Set(outline.map(([, z]) => z))];
  const all = [...xs, ...zs];
  const halves = [...new Set(all.flatMap((a) => all.map((b) => Math.abs(a - b) / 2)))];
  const candidates = (values) => values.flatMap((value) => halves.flatMap((half) => [value - half, value + half]));
  const [cx, cz] = [candidates(xs), candidates(zs)];
  const snap = (value, options) => {
    let best = value;
    let distance = 1e-4;
    options.forEach((option) => {
      if (Math.abs(option - value) < distance) {
        [best, distance] = [option, Math.abs(option - value)];
      }
    });
    return best;
  };
  const vertices = skeleton.vertices.map(([x, z, time]) => [snap(x, cx), snap(z, cz), time]);
  // a node's time: its distance from the base line of any face through it
  const baseLines = skeleton.polygons.map((indices) => {
    const base = indices.filter((index) => skeleton.vertices[index][2] < 1e-5).map((index) => vertices[index]);
    if (base.length !== 2) {
      return null;
    }
    const [a, b] = base;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return { a, direction: [(b[0] - a[0]) / length, (b[1] - a[1]) / length] };
  });
  skeleton.polygons.forEach((indices, k) => {
    const line = baseLines[k];
    if (!line) {
      return;
    }
    indices.forEach((index) => {
      if (skeleton.vertices[index][2] >= 1e-5) {
        const [x, z] = vertices[index];
        vertices[index][2] = Math.abs(line.direction[0] * (z - line.a[1]) - line.direction[1] * (x - line.a[0]));
      } else {
        vertices[index][2] = 0;
      }
    });
  });
  return { ...skeleton, vertices };
}

/** A footprint pushed out by `distance` on every side (its corners mitred, at any angle). */
function offsetRectilinear(footprint, distance) {
  const area = footprint.reduce((sum, [x, z], i) => {
    const [nx, nz] = footprint[(i + 1) % footprint.length];
    return sum + x * nz - nx * z;
  }, 0);
  const turn = Math.sign(area) || 1;
  // outward normal of the edge from a to b
  const normal = ([ax, az], [bx, bz]) => {
    const length = Math.hypot(bx - ax, bz - az) || 1;
    return [turn * (bz - az) / length, -turn * (bx - ax) / length];
  };
  return footprint.map((point, i) => {
    const previous = footprint[(i + footprint.length - 1) % footprint.length];
    const next = footprint[(i + 1) % footprint.length];
    const [n1, n2] = [normal(previous, point), normal(point, next)];
    // where the two pushed-out edges meet (at a right angle each normal moves one coordinate)
    const scale = distance / (1 + n1[0] * n2[0] + n1[1] * n2[1]);
    return [point[0] + scale * (n1[0] + n2[0]), point[1] + scale * (n1[1] + n2[1])];
  });
}

/**
 * The eave trim of a continuous hip: a fascia down the eave line all round,
 * and a soffit from it back to the walls, flat at the fascia's foot or
 * sloped up to the walls (`eaves.eaveSoffit`).
 */
function skeletonEaveTrim(footprint, outline, eaveY, eaves) {
  const fascia = eaves.fasciaDepth ?? 0;
  const triangles = [];
  outline.forEach((point, i) => {
    const next = outline[(i + 1) % outline.length];
    const [a, b] = [[point[0], eaveY, point[1]], [next[0], eaveY, next[1]]];
    const [c, d] = [[next[0], eaveY - fascia, next[1]], [point[0], eaveY - fascia, point[1]]];
    triangles.push([a, b, c], [a, c, d]);
  });
  const innerY = eaves.eaveSoffit === 'sloped' ? -fascia : eaveY - fascia;
  const outer = outline.map(([x, z]) => [x, eaveY - fascia, z]);
  const inner = footprint.map(([x, z]) => [x, innerY, z]);
  const vertices = [...outer, ...inner];
  THREE.ShapeUtils.triangulateShape(outline.map(([x, z]) => new THREE.Vector2(x, z)), [footprint.map(([x, z]) => new THREE.Vector2(x, z))])
    .forEach((triangle) => triangles.push(triangle.map((index) => vertices[index])));
  return triangles;
}

/** The plane of a skeleton face rising from its (axis-aligned) base edge, at height `baseHeight` there, as an eave plane. */
function skeletonFacePlane(edge, polygon, pitchRatio, baseHeight = 0) {
  if (Math.abs(edge[0][1] - edge[1][1]) > 1e-9 && Math.abs(edge[0][0] - edge[1][0]) > 1e-9) {
    // an angled wall's face
    const inside = [polygon.reduce((sum, v) => sum + v[0], 0) / polygon.length, polygon.reduce((sum, v) => sum + v[2], 0) / polygon.length];
    return { ...makeEdgePlane(edge[0], edge[1], pitchRatio, inside), offset: baseHeight };
  }
  const alongX = Math.abs(edge[0][1] - edge[1][1]) < 1e-9;
  const [axis, k] = alongX ? ['z', 2] : ['x', 0];
  const constant = alongX ? edge[0][1] : edge[0][0];
  const inward = polygon.reduce((sum, v) => sum + v[k], 0) / polygon.length - constant;
  return {
    axis, sign: Math.sign(inward) || 1, constant, slope: pitchRatio, offset: baseHeight, side: `${inward > 0 ? 'min' : 'max'}${axis.toUpperCase()}`,
  };
}

/** Which way a plan polygon winds: 1 when inside is to the left of each edge (a positive shoelace sum), else -1. */
function outlineSide(outline) {
  return Math.sign(outline.reduce((sum, [x, z], i) => {
    const [nx, nz] = outline[(i + 1) % outline.length];
    return sum + x * nz - nx * z;
  }, 0)) || 1;
}

/** A plan polygon clipped to a convex outline (a cut volume's). */
function clipToOutline(polygon, outline) {
  const turn = outlineSide(outline);
  return outline.reduce((piece, a, i) => {
    const b = outline[(i + 1) % outline.length];
    return piece.length >= 3 ? clipPolygon(piece, ([x, z]) => turn * ((b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]))) : piece;
  }, polygon);
}

/** A plan polygon clipped to a rectangle. */
function clipToBounds(polygon, bounds) {
  return [
    ([x]) => x - bounds.minX, ([x]) => bounds.maxX - x, ([, z]) => z - bounds.minZ, ([, z]) => bounds.maxZ - z,
  ].reduce((piece, distance) => (piece.length ? clipPolygon(piece, distance) : piece), polygon);
}

/** A simple plan polygon as convex pieces: itself if convex, otherwise its triangles. */
function convexPieces(input) {
  // clipping can leave a point repeated (a zero-length edge, which has no side to bound a prism)
  const polygon = input.filter((point, i) => {
    const next = input[(i + 1) % input.length];
    return Math.hypot(next[0] - point[0], next[1] - point[1]) > 1e-9;
  });
  const area = (points) => points.reduce((sum, [x, z], i) => {
    const [nx, nz] = points[(i + 1) % points.length];
    return sum + x * nz - nx * z;
  }, 0) / 2;
  if (polygon.length < 3 || Math.abs(area(polygon)) < 1e-9) {
    return [];
  }
  const turn = Math.sign(area(polygon));
  const convex = polygon.every(([x0, z0], i) => {
    const [x1, z1] = polygon[(i + 1) % polygon.length];
    const [x2, z2] = polygon[(i + 2) % polygon.length];
    return turn * ((x1 - x0) * (z2 - z1) - (z1 - z0) * (x2 - x1)) >= -1e-9;
  });
  if (convex) {
    return [polygon];
  }
  return THREE.ShapeUtils.triangulateShape(polygon.map(([x, z]) => new THREE.Vector2(x, z)), [])
    .map((triangle) => triangle.map((index) => polygon[index]))
    .filter((triangle) => Math.abs(area(triangle)) > 1e-9);
}

/**
 * The widow's walk height of a continuous (straight-skeleton) hip: one flat
 * top at one height across every volume, the building's, or failing that the
 * lowest a volume sets.
 */
function skeletonWalkHeight(config) {
  if (config.roofWalkHeight > 0) {
    return config.roofWalkHeight;
  }
  const own = (config.volumes ?? []).map((volume) => config.volumeRoofShapes?.[volume.id]?.walkHeight).filter((height) => height > 0);
  return own.length ? Math.min(...own) : undefined;
}

/**
 * Zone descriptors for the volumes under a straight-skeleton hip roof (one
 * continuous hip over the whole footprint). Each skeleton face is a plane
 * rising at the pitch from one footprint edge. Inside a volume the roof is
 * not the min of its own planes (near an inner side or a valley), so the
 * descriptor lists the roof exactly as convex plan pieces, each under one
 * face's plane (`roofPieces`; zoneSolids makes a prism of each), and is
 * marked `skeleton` rather than `exact`. `planes` holds the planes of the
 * volume's sides on the footprint's outline (the faces a dormer can stand
 * on), and `faceRegions[side]` where each one is the roof, in plan.
 */
function skeletonHipZones(volumes, {
  faces, pitchRatio, walk, walkFaces, overhang = 0, eaves = {},
}) {
  return (volumes ?? []).map((volume) => {
    const bounds = { minX: volume.minX, maxX: volume.maxX, minZ: volume.minZ, maxZ: volume.maxZ };
    const planes = [];
    const faceRegions = {};
    // the eave runs along the stretches of each side that are outside walls
    const overhangs = {};
    const partial = {};
    ['minX', 'maxX', 'minZ', 'maxZ'].forEach((side) => {
      const k = side === 'minX' || side === 'maxX' ? 0 : 1;
      const [lo, hi] = k === 0 ? [bounds.minZ, bounds.maxZ] : [bounds.minX, bounds.maxX];
      // an outside wall's face rises from the eave line, out past it
      const eaveLine = bounds[side] + (side.startsWith('min') ? -overhang : overhang);
      const onSide = faces.filter(({ edge }) => edge.every((point) => Math.abs(point[k] - eaveLine) < 1e-6)
        && Math.min(Math.max(edge[0][1 - k], edge[1][1 - k]), hi) - Math.max(Math.min(edge[0][1 - k], edge[1][1 - k]), lo) > 1e-6);
      if (onSide.length) {
        planes.push({ ...makeEavePlane(bounds, side, pitchRatio) });
        faceRegions[side] = onSide.map(({ polygon }) => polygon.map(([x, , z]) => [x, z]));
        if (overhang) {
          // the stretch of wall under each eave edge (which runs on to where eave lines cross, `overhang` further)
          const spans = onSide.map(({ edge }) => [
            Math.max(lo, Math.min(edge[0][1 - k], edge[1][1 - k]) - overhang), Math.min(hi, Math.max(edge[0][1 - k], edge[1][1 - k]) + overhang),
          ]).sort((a, b) => a[0] - b[0]);
          const covered = spans.reduce((reach, [a0, a1]) => (a0 <= reach + 1e-6 ? Math.max(reach, a1) : reach), lo);
          if (covered >= hi - 1e-6) {
            overhangs[side] = overhang;
          } else {
            partial[side] = spans.map(([a0, a1]) => ({ a0, a1, cap0: false, cap1: false }));
          }
        }
      }
    });
    // an angled wall of this volume rises into its own face
    faces.filter(({ edge }) => Math.abs(edge[0][0] - edge[1][0]) > 1e-9 && Math.abs(edge[0][1] - edge[1][1]) > 1e-9)
      .filter(({ polygon }) => volume.outline && clipToOutline(polygon.map(([x, , z]) => [x, z]), volume.outline).length >= 3)
      .forEach(({ edge, polygon }) => planes.push(skeletonFacePlane(edge, polygon, pitchRatio, -pitchRatio * overhang)));
    if (walk) {
      planes.push({ constantHeight: walk.height, tier: 'walk' });
    }
    const clip = (polygon) => (volume.outline ? clipToOutline(polygon, volume.outline) : clipToBounds(polygon, bounds));
    // the exact roof over this volume: each skeleton face (and the walk) within it, in convex pieces
    const roofPieces = [
      ...faces.map(({ edge, polygon }) => ({ polygon, plane: skeletonFacePlane(edge, polygon, pitchRatio, -pitchRatio * overhang) })),
      ...walkFaces.map((polygon) => ({ polygon, plane: { constantHeight: walk.height, tier: 'walk' } })),
    ].flatMap(({ polygon, plane }) => convexPieces(clip(polygon.map(([x, , z]) => [x, z])))
      .map((piece) => ({ polygon: piece, plane })));
    // the highest point of the roof over this volume
    const inside = [
      (v) => v[0] - bounds.minX, (v) => bounds.maxX - v[0], (v) => v[2] - bounds.minZ, (v) => bounds.maxZ - v[2],
    ];
    const allFaces = [...faces.map(({ polygon }) => polygon), ...walkFaces];
    const within = (polygon) => (volume.outline
      ? volume.outline.reduce((piece, a, i) => {
        const b = volume.outline[(i + 1) % volume.outline.length];
        return clipPolygon(piece, (v) => outlineSide(volume.outline) * ((b[0] - a[0]) * (v[2] - a[1]) - (b[1] - a[1]) * (v[0] - a[0])));
      }, polygon)
      : inside.reduce((piece, distance) => clipPolygon(piece, distance), polygon));
    const roofHeight = Math.max(0, ...allFaces.flatMap((polygon) => within(polygon).map((v) => v[1])));
    return {
      volumeId: volume.id,
      roofType: 'hip',
      bounds,
      roofBounds: bounds,
      ...(volume.outline ? { outline: volume.outline } : {}),
      ridgeAxis: volume.ridgeAxis,
      roofHeight,
      planes,
      faceRegions,
      skeletonFaces: allFaces,
      roofPieces,
      slabThickness: 0,
      // its eaves run all round the outside walls: a side partly inside the
      // footprint has them along its outside stretches only
      overhang: overhangs,
      eaves: { ...eaves, partial },
      exact: false,
      skeleton: true,
      baseY: 0,
      wallTopY: 0,
    };
  });
}

/**
 * Build a hip/gable roof for a non-rectangular footprint as an assembly of
 * exact, flat-faced analytic roofs (2 quads + 2 triangles each), one per
 * rectangular volume from decomposeIntoVolumes, each ridge-oriented along its
 * own long axis. This gives correctly flat, non-faceted roof planes.
 *
 * config.roofHeightMode selects which quantity is held constant across
 * volumes of differing width:
 * - 'slope' (default): every volume uses the same pitch, so ridge height
 *   varies with each volume's own half-width (a wider volume gets a taller
 *   ridge).
 * - 'height': every volume's ridge uses config.roofHeight, so each volume's
 *   effective pitch is derived from its own half-width to hit that target (a
 *   wider volume gets a visibly flatter, but still fully peaked, roof).
 *
 * Adjacent volumes meet at a vertical seam along their shared wall rather
 * than blending into one continuous mitered valley in either mode; true
 * seamless mitering requires a full straight-skeleton solve, which is a
 * distinct, larger follow-up (see Task 9 notes in IMPLEMENTATION_PLAN.md).
 */
function createVolumeRoofAssembly(volumes, config) {
  const directedVolumes = applyVolumeRidgeDirections(volumes, config.volumeRidgeDirections ?? {});
  const hasGableVolume = directedVolumes.some((volume) => ['gable', 'gambrel'].includes(config.volumeRoofTypes?.[volume.id] ?? config.roofType));
  const roofVolumes = hasGableVolume
    ? resolveGableRidgeDirections(directedVolumes)
    : directedVolumes;
  const paramsFor = (volume, bounds) => volumeRoofParams(volume.id, halfSpanForBounds(bounds, volume.ridgeAxis), config);
  const ridgeHeights = new Map(roofVolumes.map((volume) => {
    const roofType = config.volumeRoofTypes?.[volume.id] ?? config.roofType;
    const height = roofType === 'flat' ? 0 : paramsFor(volume, volume).roofHeight;
    return [volume.id, height];
  }));
  const anyHeightMode = roofVolumes.some((volume) => paramsFor(volume, volume).mode === 'height');
  // Ridge-to-ridge joins are opt-in now (see resolveRoofConnections); only the
  // older equal-rise hip/height-mode connection still nudges endpoints itself.
  const ridgeEndpoints = anyHeightMode
    ? buildConnectedConstantRiseRidges(roofVolumes, config.roofType === 'hip', ridgeHeights)
    : new Map();
  const connections = resolveRoofConnections(roofVolumes, config);
  const adjacentSides = adjacentSidesByVolume(roofVolumes);
  const setups = buildRoofSetups(roofVolumes, config, connections, adjacentSides, (volume) => config.volumeRoofTypes?.[volume.id] ?? config.roofType);

  const zones = [];
  const chunks = roofVolumes.map((volume) => {
    const roofType = config.volumeRoofTypes?.[volume.id] ?? config.roofType;
    const volumeConnections = connections.get(volume.id);
    const { bounds, extendedRoofHeight } = applyRoofExtension(
      { minX: volume.minX, maxX: volume.maxX, minZ: volume.minZ, maxZ: volume.maxZ },
      roofType,
      volumeConnections
    );
    const params = paramsFor(volume, bounds);
    const setup = setups.get(volume.id);
    const gableMerge = roofType === 'gable' ? gableMergeGeometry(volume, bounds, volumeConnections, params.roofHeight) : null;
    const roofConfig = {
      roofDirection: volume.ridgeAxis,
      roofHighEdge: volume.roofHighEdge ?? defaultHighEdgeForAxis(volume.ridgeAxis),
      roofHeight: extendedRoofHeight ?? (gableMerge?.any ? gableMerge.roofHeight : params.roofHeight),
      overhang: setup.overhang,
      eaves: setup.eaves,
      abut: eaveAbutments(volumeConnections, setups),
      roofPitchRise: params.pitchRise,
      roofPitchRun: params.pitchRun,
      ridgeEndpoints: gableMerge?.any
        ? gableMerge.endpoints
        : (roofType !== 'gable' && params.mode === 'height' ? ridgeEndpoints.get(volume.id) : undefined),
      mergedEnds: gableMerge?.mergedEnds,
      connections: volumeConnections,
    };
    if (roofType === 'hip') {
      Object.assign(roofConfig, withHipWalk(roofConfig, volume.id, config));
    }
    if (isTwoSlope(roofType)) {
      const unsloped = unslopedSidesOf(adjacentSides.get(volume.id), volume);
      Object.assign(roofConfig, withTwoSlope(roofConfig, volume.id, roofType, config, bounds, unsloped), {
        roofType,
        neighborSolids: neighborSolidsForEnds(volume, unsloped, roofVolumes, config, adjacentSides),
      });
    }
    if (volume.outline) {
      // cut by angled walls (see js/cut-roofs.js); its walls against other volumes stay open
      const cut = createCutVolumeRoof(volume, roofType, config, { setup, roofConfig, sharedEdge: sharedEdgeTest(volume, roofVolumes) });
      zones.push(...cut.zones);
      return clipInsideNeighbor(cut.geometry, volumeConnections);
    }
    const chunk = isTwoSlope(roofType)
      ? createTwoSlopeRoofGeometry(bounds, roofConfig)
      : roofType === 'flat'
      ? createFlatRoofGeometry(bounds, setup.overhang)
      : roofType === 'gable'
        ? createGableRoofGeometry(bounds, roofConfig)
        : roofType === 'hip'
          ? createHipRoofGeometry(bounds, roofConfig)
          : createShedRoofGeometry(bounds, roofConfig);
    zones.push(roofZoneDescriptor(volume.id, {
      wallBounds: { minX: volume.minX, maxX: volume.maxX, minZ: volume.minZ, maxZ: volume.maxZ },
      roofBounds: bounds,
      roofType,
      roofConfig,
      setup,
      exact: !(roofType === 'hip' && roofConfig.ridgeEndpoints) && !hasCoplanarShedMerge(roofType, volumeConnections),
    }));
    return clipInsideNeighbor(chunk, volumeConnections);
  });
  // a roof a gable merges into keeps its eave along the whole side; it is cut
  // where it passes into the merging roof (whose valleys take over there);
  // a cut roof's walls and eaves are cut where they pass into a neighbor
  const zonesById = new Map(zones.map((zone) => [zone.volumeId, zone]));
  const clipped = chunks.map((chunk, index) => {
    const merging = [
      ...mergingNeighbors(roofVolumes[index].id, connections),
      ...(roofVolumes[index].outline ? neighborIds(roofVolumes[index], roofVolumes) : []),
    ];
    if (!merging.length) {
      return chunk;
    }
    const triangles = merging.reduce(
      (kept, id) => clipOutsideConvexSolid(kept, volumeSolid(zonesById.get(id), { floorY: -1e3 })),
      geometryTriangles(chunk)
    );
    chunk.dispose();
    return trianglesToGeometry(triangles);
  });
  return { geometry: mergeFlatGeometries(clipped), zones };
}

/** The ids of the volumes that share a wall with `volume`. */
function neighborIds(volume, volumes) {
  return [...new Set(findVolumeAdjacencies(volumes).flatMap((adjacency) => [
    adjacency.volumeAId === volume.id ? adjacency.volumeBId : null,
    adjacency.volumeBId === volume.id ? adjacency.volumeAId : null,
  ]).filter(Boolean))];
}

/** The volumes whose gable ends merge into `volumeId`'s roof (see resolveRoofConnections). */
function mergingNeighbors(volumeId, connections) {
  return [...connections].filter(([, sides]) => Object.values(sides ?? {})
    .some((resolution) => resolution.gableEnd && resolution.neighborId === volumeId))
    .map(([id]) => id);
}

function applyVolumeRidgeDirections(volumes, directions) {
  return volumes.map((volume) => {
    const highEdge = directions[volume.id];
    if (!highEdge) {
      return volume;
    }
    return {
      ...volume,
      ridgeAxis: roofAxisForDirection(highEdge),
      roofHighEdge: highEdge.length > 1 ? highEdge : defaultHighEdgeForAxis(highEdge),
      ridgeDirectionOverride: true,
    };
  });
}

function resolveGableRidgeDirections(volumes) {
  const primary = volumes.reduce((largest, volume) => {
    const area = (volume.maxX - volume.minX) * (volume.maxZ - volume.minZ);
    const largestArea = (largest.maxX - largest.minX) * (largest.maxZ - largest.minZ);
    return area > largestArea ? volume : largest;
  }, volumes[0]);
  const epsilon = 1e-6;

  return volumes.map((volume) => {
    if (volume.id === primary.id || volume.ridgeDirectionOverride || volume.ridgeAxis !== primary.ridgeAxis) {
      return volume;
    }
    const sharesHorizontalBoundary = (Math.abs(volume.maxZ - primary.minZ) < epsilon
      || Math.abs(volume.minZ - primary.maxZ) < epsilon)
      && Math.min(volume.maxX, primary.maxX) - Math.max(volume.minX, primary.minX) > epsilon;
    const sharesVerticalBoundary = (Math.abs(volume.maxX - primary.minX) < epsilon
      || Math.abs(volume.minX - primary.maxX) < epsilon)
      && Math.min(volume.maxZ, primary.maxZ) - Math.max(volume.minZ, primary.minZ) > epsilon;
    if (!sharesHorizontalBoundary && !sharesVerticalBoundary) {
      return volume;
    }
    return { ...volume, ridgeAxis: primary.ridgeAxis === 'x' ? 'z' : 'x' };
  });
}

const MERGE_HEIGHT_EPSILON = 0.02;

function sideCorners(bounds, side) {
  if (side === 'minX' || side === 'maxX') {
    return [[bounds[side], bounds.minZ], [bounds[side], bounds.maxZ]];
  }
  return [[bounds.minX, bounds[side]], [bounds.maxX, bounds[side]]];
}

/**
 * A shed whose plane slopes *along* the shared wall (its high edge is on a
 * side, so the wall is one of its rakes) meets the neighbor's eave-side roof
 * plane along a straight valley. Where the shed's roof is above the
 * neighbor's eave (`gap` above this roof's plate) it keeps its own plane and
 * runs on into the neighbor as a triangle whose far edge is that valley; the
 * part below the neighbor's eave just butts its wall, as a standalone roof.
 * If the shed would rise above the neighbor's ridge, the whole plane is
 * lowered (staying planar) so its high corner lands on the ridge.
 */
function resolveShedRakeMerge(own, neighbor, side, gap, ridgePlanes) {
  const mergeAxis = side === 'minX' || side === 'maxX' ? 'x' : 'z';
  const ownPlane = own.planes[0];
  const planeAxis = ownPlane.axis;
  const wallCoord = own.bounds[side];
  const facingPlane = ridgePlanes.reduce((best, plane) => (
    Math.abs(plane.constant - wallCoord) < Math.abs(best.constant - wallCoord) ? plane : best
  ));
  const ridgeCoord = (ridgePlanes[0].constant + ridgePlanes[1].constant) / 2;
  const direction = Math.sign(ridgeCoord - wallCoord);
  const lowKey = planeAxis === 'x' ? ['minX', 'maxX'] : ['minZ', 'maxZ'];
  const aLow = ownPlane.constant;
  const aHigh = Math.abs(own.bounds[lowKey[0]] - aLow) < Math.abs(own.bounds[lowKey[1]] - aLow)
    ? own.bounds[lowKey[1]]
    : own.bounds[lowKey[0]];
  const span = Math.abs(aHigh - aLow);
  const cap = neighbor.ridgeHeight + gap;
  const peak = Math.min(own.ridgeHeight, cap);
  if (span <= MERGE_HEIGHT_EPSILON || facingPlane.slope <= 1e-9 || peak <= gap + MERGE_HEIGHT_EPSILON) {
    return null;
  }
  const crossing = aLow + (aHigh - aLow) * (gap / peak);
  const reach = (peak - gap) / facingPlane.slope;
  const point = (a, along, height) => (mergeAxis === 'z' ? [a, height, along] : [along, height, a]);
  return {
    mode: 'merged',
    suppressClosure: true,
    override: true,
    height: peak,
    plateGap: gap,
    clip: { axis: mergeAxis, wall: wallCoord, direction, gap },
    rakeTriangle: [
      point(crossing, wallCoord, gap),
      point(aHigh, wallCoord, peak),
      point(aHigh, wallCoord + direction * reach, peak),
    ],
    neighborPlanes: [],
  };
}

/**
 * A gable meets a neighbor at one of its two gable ends (the sides across its
 * ridge). If the neighbor has a rising roof plane facing that end (a gable or
 * hip whose eave is on the shared wall), the gable's ridge keeps running into
 * it: at the ridge height the gable's own slopes meet the neighbor's plane
 * along valley lines (`kind: 'intersect'`, ridge ends where its height meets
 * that plane), and if the gable's ridge is higher than the neighbor's ridge it
 * instead snaps up to the neighbor's ridge point (`kind: 'snap'`).
 */
function resolveGableEndMerge(own, neighbor, side, gap = 0) {
  const sideAxis = side === 'minX' || side === 'maxX' ? 'x' : 'z';
  if (own.ridgeAxis !== sideAxis || own.ridgeHeight <= MERGE_HEIGHT_EPSILON + gap
    || neighbor.ridgeHeight <= MERGE_HEIGHT_EPSILON) {
    return null;
  }
  const ridgePlanes = neighbor.planes.filter((plane) => plane.axis === sideAxis);
  if (ridgePlanes.length !== 2) {
    return null;
  }
  const wallCoord = own.bounds[side];
  const facingPlane = ridgePlanes.reduce((best, plane) => (
    Math.abs(plane.constant - wallCoord) < Math.abs(best.constant - wallCoord) ? plane : best
  ));
  const ridgeCoord = (ridgePlanes[0].constant + ridgePlanes[1].constant) / 2;
  const direction = Math.sign(ridgeCoord - wallCoord);
  const runToRidge = Math.abs(ridgeCoord - wallCoord);
  if (facingPlane.slope <= 1e-9 || runToRidge <= MERGE_HEIGHT_EPSILON) {
    return null;
  }
  const end = side === 'minX' || side === 'minZ' ? 'start' : 'end';
  const intersects = own.ridgeHeight <= neighbor.ridgeHeight + gap + 1e-9;
  const height = intersects ? own.ridgeHeight : neighbor.ridgeHeight + gap;
  return {
    mode: 'merged',
    gableEnd: end,
    kind: intersects ? 'intersect' : 'snap',
    suppressClosure: true,
    // beyond the wall, what shows is above the neighbor's roof, rising from the wall at its slope
    clip: {
      axis: sideAxis, wall: wallCoord, direction, gap, slope: facingPlane.slope,
    },
    along: wallCoord + direction * ((height - gap) / facingPlane.slope),
    height,
    plateGap: gap,
    ridgeCap: neighbor.ridgeHeight + gap,
    wallCoord,
    direction,
    facingSlope: facingPlane.slope,
    neighborPlanes: [],
  };
}

/**
 * Ridge endpoints / merged-end flags for a gable whose ends were merged (see
 * resolveGableEndMerge), in the shape createGableRoofGeometry expects.
 */
function gableMergeGeometry(volume, bounds, connections, ridgeHeight) {
  const merges = Object.values(connections ?? {}).filter((resolution) => resolution.gableEnd);
  // A gable's roof faces stay planar only if its ridge is level, so the whole
  // ridge is capped at the lowest neighbor ridge it joins (its configured
  // height is ignored where it would project above); each end then runs to
  // where that level ridge meets the neighbor's plane.
  const height = merges.reduce((lowest, resolution) => Math.min(lowest, resolution.ridgeCap), ridgeHeight);
  const endpoints = {};
  const mergedEnds = {};
  merges.forEach((resolution) => {
    mergedEnds[resolution.gableEnd] = true;
    const cross = volume.ridgeAxis === 'x'
      ? (bounds.minZ + bounds.maxZ) / 2
      : (bounds.minX + bounds.maxX) / 2;
    const along = resolution.wallCoord + resolution.direction * ((height - resolution.plateGap) / resolution.facingSlope);
    endpoints[resolution.gableEnd] = volume.ridgeAxis === 'x'
      ? [along, cross, height]
      : [cross, along, height];
  });
  return { endpoints, mergedEnds, roofHeight: height, any: merges.length > 0 };
}

/**
 * Decides, per volume and per rectangle side, whether that side's roof edge
 * should merge into an adjacent volume's roof, or stay a standalone,
 * independently closed edge. Merging is an optimization, not a requirement:
 * a side is only considered when its own roof is genuinely sloped there
 * (something to merge). A gable's end merges by default (one shell, no
 * gable face stopped against the neighbor's eave) unless its volume's
 * `config.volumeRoofConnections` entry is 'standalone'; a shed merges only
 * when set to 'merge-plane' (the sidebar's "Merge into adjacent roof").
 * A merging side tries two things in
 * order, matching ARCHITECTURE.md's two connection semantics — this is a
 * single unified "merge" behavior, not two separately selectable modes:
 *
 * 1. **Coplanar plane merge.** If the neighbor's own roof surface is
 *    genuinely sloped along the whole shared wall too (e.g. a gable's end
 *    face) — the two surfaces are already at the same height at every point
 *    on that wall, so the shed's plane can just clamp to the neighbor's own
 *    plane (never projecting above it) with no gap: the closure face on that
 *    side is dropped, since the neighbor's own surface picks up right where
 *    it left off.
 * 2. **Ridge snap.** Otherwise (the common case: the shared wall is the
 *    neighbor's flat eave, with its actual ridge set back further away) —
 *    if the neighbor has a real ridge at all, treat that ridge and our own
 *    far/low eave as the two ends of one continuous span, and rebuild our
 *    plane through both, so extending it back through the wall lands
 *    exactly on the neighbor's ridge point (not just its height). Because
 *    the neighbor's own surface does *not* reach this height at the wall
 *    (it's still down at its own eave there), this is a real vertical rise
 *    that needs a physical closing face — like a real building's knee wall
 *    closing the gap between a lean-to's low wall and where its roof ties
 *    into the taller structure above — so unlike case 1, the closure face
 *    on that side is kept, just built to the new, taller derived height.
 *
 * If neither applies (no ridge, or too short a combined span) the side
 * stays standalone.
 *
 * @param {Array<object>} volumes - directed volumes (ridgeAxis/roofHighEdge already resolved)
 * @param {object} config - same config passed to createVolumeRoofAssembly
 * @returns {Map<string, Record<string, { mode: 'merged', neighborPlanes: Array<object>, override?: boolean, suppressClosure?: boolean }>>}
 */
export function resolveRoofConnections(volumes, config) {
  const planesByVolumeId = new Map(volumes.map((volume) => {
    const { bounds, roofType, planeConfig } = volumePlaneConfig(volume, config);
    return [volume.id, {
      bounds,
      roofType,
      ridgeAxis: volume.ridgeAxis,
      ridgeHeight: planeConfig.roofHeight,
      planes: computeVolumeEavePlanes(bounds, roofType, planeConfig),
    }];
  }));

  const resolutions = new Map(volumes.map((volume) => [volume.id, {}]));

  findVolumeAdjacencies(volumes).forEach(({ volumeAId, sideA, volumeBId, sideB }) => {
    [[volumeAId, sideA, volumeBId, sideB], [volumeBId, sideB, volumeAId, sideA]].forEach(([ownId, side, neighborId, neighborSide]) => {
      // Merging is opt-in: a side stays standalone unless the user explicitly
      // chose "Merge into adjacent roof" for it (the UI defaults every side
      // to 'standalone' the first time it becomes selectable, so this only
      // engages on a deliberate choice, matching a standalone shell being an
      // equally valid, unforced outcome).
      // A gable's end meeting a neighbor merges into its roof unless the
      // user chose a standalone shell (one shell, with no gable face stopped
      // against the neighbor's eave); a shed merges only on request.
      const choice = config.volumeRoofConnections?.[ownId];
      const ownType = planesByVolumeId.get(ownId).roofType;
      if (choice !== 'merge-plane' && !(choice === undefined && ownType === 'gable')) {
        return;
      }
      // Independent story counts put the two roofs on different plates. A
      // roof only interacts with a *taller* neighbor, and only once it rises
      // above that neighbor's eave (`plateGap` up): below that it just butts
      // against the neighbor's wall and stays standalone. A taller roof never
      // reaches a lower neighbor's roof at all.
      const plates = config.volumePlateHeights;
      const plateGap = plates ? (plates[neighborId] ?? 0) - (plates[ownId] ?? 0) : 0;
      if (plateGap < -1e-6) {
        return;
      }
      const own = planesByVolumeId.get(ownId);
      const neighbor = planesByVolumeId.get(neighborId);
      // mansard and gambrel roofs close their shared sides themselves (see
      // createTwoSlopeRoofGeometry), and a roof cut by angled walls stands
      // alone (see js/cut-roofs.js)
      const cutIds = new Set(volumes.filter((volume) => volume.outline).map((volume) => volume.id));
      if (isTwoSlope(own.roofType) || isTwoSlope(neighbor.roofType) || cutIds.has(ownId) || cutIds.has(neighborId)) {
        return;
      }
      if (own.roofType === 'gable') {
        const resolution = resolveGableEndMerge(own, neighbor, side, Math.max(0, plateGap));
        if (resolution) {
          resolutions.get(ownId)[side] = { ...resolution, neighborId, neighborSide };
        }
        return;
      }
      const corners = sideCorners(own.bounds, side);
      const ownHeights = corners.map(([x, z]) => evalZoneHeight(own.planes, x, z));
      if (Math.max(...ownHeights) <= MERGE_HEIGHT_EPSILON + Math.max(0, plateGap)) {
        return;
      }
      const gap = Math.max(0, plateGap);

      // 1. Coplanar plane merge: the neighbor is genuinely sloped along the
      // whole shared wall (e.g. a gable end face).
      const neighborHeights = corners.map(([x, z]) => evalZoneHeight(neighbor.planes, x, z));
      if (Math.min(...neighborHeights) > MERGE_HEIGHT_EPSILON) {
        resolutions.get(ownId)[side] = {
          mode: 'merged',
          neighborPlanes: gap > 0 ? neighbor.planes.map((plane) => ({ ...plane, offset: (plane.offset ?? 0) + gap })) : neighbor.planes,
          suppressClosure: true,
        };
        return;
      }

      // 2. Ridge snap fallback: the shared wall is the neighbor's flat eave,
      // but it has a real ridge set back further in that carries a genuine
      // height worth reaching up to.
      if (neighbor.ridgeHeight <= MERGE_HEIGHT_EPSILON) {
        return;
      }
      const mergeAxis = side === 'minX' || side === 'maxX' ? 'x' : 'z';
      const neighborRidgePlanes = neighbor.planes.filter((plane) => plane.axis === mergeAxis);
      const ownSpanPlanes = own.planes.filter((plane) => plane.axis === mergeAxis);
      if (neighborRidgePlanes.length === 2 && ownSpanPlanes.length === 1) {
        const ridgeCoord = (neighborRidgePlanes[0].constant + neighborRidgePlanes[1].constant) / 2;
        const ownPlane = ownSpanPlanes[0];

        // 2a. Keep the shed's own configured slope and let it run on into the
        // neighbor until it meets the neighbor's rising roof plane. When that
        // crossing lands at or below the ridge, that is the merge: the shed
        // keeps its pitch and its roof simply ends where it intersects the
        // neighbor's plane (a valley-style join), with nothing left to close.
        const wallCoord = own.bounds[side];
        const facingPlane = neighborRidgePlanes.reduce((best, plane) => (
          Math.abs(plane.constant - wallCoord) < Math.abs(best.constant - wallCoord) ? plane : best
        ));
        const wallHeight = ownPlane.slope * ownPlane.sign * (wallCoord - ownPlane.constant);
        const slopeGap = facingPlane.slope - ownPlane.slope;
        const runToRidge = Math.abs(ridgeCoord - wallCoord);
        // Heights above are on this roof's own plate; the neighbor's eave sits
        // `gap` above it, so only the part above that competes with its roof.
        if (wallHeight - gap > MERGE_HEIGHT_EPSILON && slopeGap > 1e-9) {
          const run = (wallHeight - gap) / slopeGap;
          if (run <= runToRidge) {
            const extendTo = wallCoord + Math.sign(ridgeCoord - wallCoord) * run;
            resolutions.get(ownId)[side] = {
              mode: 'merged',
              override: true,
              suppressClosure: true,
              clip: { axis: mergeAxis, wall: wallCoord, direction: Math.sign(ridgeCoord - wallCoord), gap },
              intersectsPlane: true,
              extendTo,
              height: wallHeight + ownPlane.slope * run,
              neighborPlanes: [{ ...ownPlane }],
            };
            return;
          }
        }

        // 2b. The shed's own slope would still be above the neighbor's plane
        // when it reaches the ridge, i.e. it would project above the ridge:
        // snap to the ridge instead, with a plane rebuilt through the ridge
        // point and the shed's own far eave.
        const combinedSpan = Math.abs(ownPlane.constant - ridgeCoord);
        if (combinedSpan > MERGE_HEIGHT_EPSILON && wallHeight > gap + MERGE_HEIGHT_EPSILON) {
          // This is not just a height clamp at the existing wall: the roof's
          // own boundary is physically relocated from the wall out to the
          // neighbor's actual ridge coordinate (`extendTo`), the way a real
          // saltbox's rear slope is one continuous surface running from the
          // ridge, over the wall, to its own low eave — so there is no edge
          // left at the old wall to close at all (the "high edge" now *is*
          // the ridge, same as any roof's ridge needs no vertical closure).
          // The extended surface passes directly over the neighbor's own
          // rear-facing portion (hidden beneath it, since a plane through
          // the same ridge point with a shallower slope — reaching all the
          // way to this shed's own far eave instead of just the neighbor's
          // near eave — is always higher there), so nothing needs clipping.
          resolutions.get(ownId)[side] = {
            mode: 'merged',
            override: true,
            suppressClosure: true,
            clip: { axis: mergeAxis, wall: wallCoord, direction: Math.sign(ridgeCoord - wallCoord), gap },
            extendTo: ridgeCoord,
            height: neighbor.ridgeHeight + gap,
            neighborPlanes: [{
              axis: ownPlane.axis, sign: ownPlane.sign, constant: ownPlane.constant,
              slope: (neighbor.ridgeHeight + gap) / combinedSpan,
            }],
          };
        }
        return;
      }
      // A shed whose slope runs along the shared wall (its rake meets the
      // neighbor) merges through a triangle of extra roof instead.
      if (neighborRidgePlanes.length === 2 && ownSpanPlanes.length === 0 && own.planes.length === 1) {
        const resolution = resolveShedRakeMerge(own, neighbor, side, gap, neighborRidgePlanes);
        if (resolution) {
          resolutions.get(ownId)[side] = resolution;
        }
        return;
      }
      // Fallback for shapes without a clean single ridge line on this axis
      // (e.g. a flat or shed neighbor): just target its own peak height.
      resolutions.get(ownId)[side] = {
        mode: 'merged', override: true, suppressClosure: false, neighborPlanes: [{ constantHeight: neighbor.ridgeHeight + gap }],
      };
    });
  });

  return resolutions;
}

/**
 * Roof surface that a merge carries into the taller neighbor lies inside that
 * neighbor's walls below its eave (`gap` above this roof's plate), where it is
 * hidden at best and z-fights with the wall where the faces are coplanar (a
 * flush outer wall). Cut it away: drop everything past the shared wall
 * (`axis`/`wall`/`direction`) that is lower than `gap`.
 */
function clipInsideNeighbor(geometry, connections) {
  const clips = Object.values(connections ?? {}).map((resolution) => resolution.clip).filter(Boolean);
  if (clips.length === 0 || clips.every((clip) => clip.gap <= MERGE_HEIGHT_EPSILON)) {
    return geometry;
  }
  let polygons = geometryTriangles(geometry);
  clips.forEach(({
    axis, wall, direction, gap, slope = 0,
  }) => {
    const beyond = (v) => direction * ((axis === 'x' ? v[0] : v[2]) - wall);
    polygons = polygons.flatMap((polygon) => {
      const near = clipPolygon(polygon, (v) => -beyond(v));
      const far = clipPolygon(clipPolygon(polygon, beyond), (v) => v[1] - gap - slope * beyond(v));
      return [near, far].filter((poly) => poly.length >= 3);
    });
  });
  return trianglesToGeometry(polygonsToTriangles(polygons));
}

/** The triangles of a (possibly indexed) geometry, as [[x, y, z] x 3] arrays. */
function geometryTriangles(geometry) {
  const position = geometry.getAttribute('position');
  const index = geometry.index;
  const count = index ? index.count : position.count;
  const triangles = [];
  for (let i = 0; i < count; i += 3) {
    triangles.push([0, 1, 2].map((k) => {
      const v = index ? index.getX(i + k) : i + k;
      return [position.getX(v), position.getY(v), position.getZ(v)];
    }));
  }
  return triangles;
}

function trianglesToGeometry(triangles) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(triangles.flat(2), 3));
  geometry.computeVertexNormals();
  return geometry;
}

function mergeFlatGeometries(geometries) {
  const positions = [];
  geometries.forEach((geometry) => {
    const position = geometry.getAttribute('position');
    const index = geometry.index;
    if (index) {
      for (let i = 0; i < index.count; i += 1) {
        const vertexIndex = index.getX(i);
        positions.push(position.getX(vertexIndex), position.getY(vertexIndex), position.getZ(vertexIndex));
      }
    } else {
      for (let i = 0; i < position.count; i += 1) {
        positions.push(position.getX(i), position.getY(i), position.getZ(i));
      }
    }
  });
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.computeVertexNormals();
  return merged;
}

/**
 * Build a roof surface for an arbitrary rectilinear footprint using the
 * perpendicular distance to the nearest qualifying exterior wall edge as the
 * height field. This is a straight-skeleton approximation that is exact for
 * axis-aligned polygons: it produces correctly seamed hips at convex corners
 * and valleys at concave (re-entrant) corners automatically, because the
 * ridge/valley line is simply where two edges are equidistant.
 *
 * Note: this generates a single roof spanning the whole footprint. Wings or
 * additions that need an independent roof height (e.g. a one-story lean-to
 * under a two-story main roof) require separate massing volumes, which is a
 * distinct planned step (see Task 9 in IMPLEMENTATION_PLAN.md).
 */
function createRoofFieldSurface(footprint, config) {
  const edges = config.roofHeightMode === 'height' && config.volumes?.length > 1
    ? buildFixedRiseRoofEdges(footprint, config.volumes, config.roofHeight ?? 2)
    : classifyFootprintEdges(footprint);
  const xs = buildRoofGridLines(footprint.map(([x]) => x));
  const zs = buildRoofGridLines(footprint.map(([, z]) => z));
  const rawHeights = [];
  let maximumDistance = 0;

  for (let zi = 0; zi < zs.length; zi += 1) {
    const row = [];
    for (let xi = 0; xi < xs.length; xi += 1) {
      const x = xs[xi];
      const z = zs[zi];
      const distance = isPointCoveredByFootprint(x, z, footprint, edges)
        ? roofFieldHeightAt(x, z, edges, config.roofType, config.roofDirection, 1)
        : null;
      if (distance !== null) {
        maximumDistance = Math.max(maximumDistance, distance);
      }
      row.push(distance);
    }
    rawHeights.push(row);
  }

  const pitchRatio = config.roofHeightMode === 'height'
    ? 1
    : (config.roofPitchRise ?? 6) / (config.roofPitchRun ?? 12);

  const indexGrid = [];
  const positions = [];
  for (let zi = 0; zi < zs.length; zi += 1) {
    const row = [];
    for (let xi = 0; xi < xs.length; xi += 1) {
      const x = xs[xi];
      const z = zs[zi];
      const distance = rawHeights[zi][xi];
      if (distance !== null) {
        const height = distance * pitchRatio;
        row.push(positions.length / 3);
        positions.push(x, height, z);
      } else {
        row.push(-1);
      }
    }
    indexGrid.push(row);
  }

  const indices = [];
  for (let zi = 0; zi < zs.length - 1; zi += 1) {
    for (let xi = 0; xi < xs.length - 1; xi += 1) {
      const a = indexGrid[zi][xi];
      const b = indexGrid[zi][xi + 1];
      const c = indexGrid[zi + 1][xi];
      const d = indexGrid[zi + 1][xi + 1];
      if (a >= 0 && b >= 0 && c >= 0 && d >= 0) {
        indices.push(a, c, b, b, c, d);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function buildRoofGridLines(values, subdivisionsPerSegment = 14) {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  if (sorted.length < 2) {
    return sorted;
  }
  const lines = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i];
    const b = sorted[i + 1];
    for (let s = 0; s < subdivisionsPerSegment; s += 1) {
      lines.push(a + ((b - a) * s) / subdivisionsPerSegment);
    }
  }
  lines.push(sorted[sorted.length - 1]);
  return lines;
}

function classifyFootprintEdges(footprint) {
  return footprint.map(([x, z], index) => {
    const [ex, ez] = footprint[(index + 1) % footprint.length];
    let orientation = null;
    if (Math.abs(x - ex) < 1e-6) {
      orientation = 'vertical';
    } else if (Math.abs(z - ez) < 1e-6) {
      orientation = 'horizontal';
    }
    return { start: [x, z], end: [ex, ez], orientation };
  });
}

function buildFixedRiseRoofEdges(footprint, volumes, roofHeight) {
  const epsilon = 1e-4;
  return classifyFootprintEdges(footprint).map((edge) => {
    const midpointX = (edge.start[0] + edge.end[0]) / 2;
    const midpointZ = (edge.start[1] + edge.end[1]) / 2;
    const owner = volumes.find((volume) => {
      if (edge.orientation === 'horizontal') {
        return midpointX >= volume.minX - epsilon
          && midpointX <= volume.maxX + epsilon
          && (Math.abs(midpointZ - volume.minZ) < epsilon || Math.abs(midpointZ - volume.maxZ) < epsilon);
      }
      return midpointZ >= volume.minZ - epsilon
        && midpointZ <= volume.maxZ + epsilon
        && (Math.abs(midpointX - volume.minX) < epsilon || Math.abs(midpointX - volume.maxX) < epsilon);
    });
    if (!owner) {
      return edge;
    }
    const bounds = { minX: owner.minX, maxX: owner.maxX, minZ: owner.minZ, maxZ: owner.maxZ };
    return {
      ...edge,
      slope: roofHeight / halfSpanForBounds(bounds, owner.ridgeAxis),
    };
  });
}

function buildConnectedConstantRiseRidges(volumes, extendSpanningRidge, ridgeHeights = new Map()) {
  const endpoints = new Map();
  const epsilon = 1e-6;

  volumes.forEach((spanning) => {
    if (spanning.ridgeAxis !== 'x') {
      return;
    }
    const centerZ = (spanning.minZ + spanning.maxZ) / 2;
    const attached = volumes.filter((side) => side.ridgeAxis === 'z'
      && side.id !== spanning.id
      && side.minX >= spanning.minX - epsilon
      && side.maxX <= spanning.maxX + epsilon
      && (Math.abs(side.minZ - spanning.maxZ) < epsilon || Math.abs(side.maxZ - spanning.minZ) < epsilon));
    if (attached.length === 0) {
      return;
    }

    const spanningEnds = {
      start: [spanning.minX + halfSpanForBounds(spanning, 'x'), centerZ, ridgeHeights.get(spanning.id)],
      end: [spanning.maxX - halfSpanForBounds(spanning, 'x'), centerZ, ridgeHeights.get(spanning.id)],
    };
    attached.forEach((side) => {
      const centerX = (side.minX + side.maxX) / 2;
      if (extendSpanningRidge) {
        if (centerX < (spanning.minX + spanning.maxX) / 2) {
          spanningEnds.start = [centerX, centerZ, ridgeHeights.get(spanning.id)];
        } else {
          spanningEnds.end = [centerX, centerZ, ridgeHeights.get(spanning.id)];
        }
      }

      const sideEndpoints = endpoints.get(side.id) ?? {
        start: [(side.minX + side.maxX) / 2, extendSpanningRidge ? side.minZ + halfSpanForBounds(side, 'z') : side.minZ, ridgeHeights.get(side.id)],
        end: [(side.minX + side.maxX) / 2, extendSpanningRidge ? side.maxZ - halfSpanForBounds(side, 'z') : side.maxZ, ridgeHeights.get(side.id)],
      };
      if (Math.abs(side.minZ - spanning.maxZ) < epsilon) {
        sideEndpoints.start = [centerX, centerZ, ridgeHeights.get(spanning.id)];
      } else {
        sideEndpoints.end = [centerX, centerZ, ridgeHeights.get(spanning.id)];
      }
      endpoints.set(side.id, sideEndpoints);
    });
    if (extendSpanningRidge) {
      endpoints.set(spanning.id, spanningEnds);
    }
  });

  return endpoints;
}

function distancePointToSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const lengthSquared = dx * dx + dz * dz;
  let t = lengthSquared > 0 ? ((px - ax) * dx + (pz - az) * dz) / lengthSquared : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cz = az + t * dz;
  return Math.hypot(px - cx, pz - cz);
}

function roofFieldHeightAt(x, z, edges, roofType, roofDirection, pitchRatio) {
  let qualifying = edges;
  if (roofType === 'gable') {
    const wanted = roofDirection === 'x' ? 'horizontal' : 'vertical';
    const filtered = edges.filter((edge) => edge.orientation === wanted);
    if (filtered.length > 0) {
      qualifying = filtered;
    }
  }

  let minHeight = Infinity;
  qualifying.forEach((edge) => {
    const distance = distancePointToSegment(x, z, edge.start[0], edge.start[1], edge.end[0], edge.end[1]);
    const height = distance * (edge.slope ?? pitchRatio);
    if (height < minHeight) {
      minHeight = height;
    }
  });

  if (!Number.isFinite(minHeight)) {
    minHeight = 0;
  }
  return minHeight;
}

function isPointInPolygon(x, z, footprint) {
  let inside = false;
  for (let i = 0, j = footprint.length - 1; i < footprint.length; j = i, i += 1) {
    const [xi, zi] = footprint[i];
    const [xj, zj] = footprint[j];
    const intersect = ((zi > z) !== (zj > z))
      && (x < ((xj - xi) * (z - zi)) / (zj - zi) + xi);
    if (intersect) {
      inside = !inside;
    }
  }
  return inside;
}

function isPointCoveredByFootprint(x, z, footprint, edges) {
  if (isPointInPolygon(x, z, footprint)) {
    return true;
  }
  return edges.some((edge) => distancePointToSegment(x, z, edge.start[0], edge.start[1], edge.end[0], edge.end[1]) < 1e-6);
}

function createFlatRoofGeometry(bounds, overhang) {
  const ov = typeof overhang === 'number'
    ? { minX: overhang, maxX: overhang, minZ: overhang, maxZ: overhang }
    : { minX: 0, maxX: 0, minZ: 0, maxZ: 0, ...overhang };
  const shape = new THREE.Shape();
  const minX = bounds.minX - ov.minX;
  const maxX = bounds.maxX + ov.maxX;
  const minZ = bounds.minZ - ov.minZ;
  const maxZ = bounds.maxZ + ov.maxZ;
  shape.moveTo(minX, -minZ);
  shape.lineTo(maxX, -minZ);
  shape.lineTo(maxX, -maxZ);
  shape.lineTo(minX, -maxZ);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: FLAT_ROOF_THICKNESS,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 1,
  });
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

function getRectangularBounds(footprint) {
  if (footprint.length !== 4) {
    return null;
  }

  const xValues = [...new Set(footprint.map(([x]) => x))];
  const zValues = [...new Set(footprint.map(([, z]) => z))];
  if (xValues.length !== 2 || zValues.length !== 2) {
    return null;
  }

  return {
    minX: Math.min(...xValues),
    maxX: Math.max(...xValues),
    minZ: Math.min(...zValues),
    maxZ: Math.max(...zValues),
  };
}

const EAVE_CONFIG_KEYS = ['roofEaveDepth', 'roofRakeDepth', 'eaveSoffit', 'rakeSoffit', 'roofFasciaDepth', 'volumeEaves'];
/** Building-wide roof shape settings: mansard and gambrel (see twoSlopeConfig), and a hip's widow's walk (see hipWalkHeight). */
const TWO_SLOPE_CONFIG_KEYS = ['roofBreakHeight', 'roofLowerPitchRise', 'roofUpperPitchRise', 'roofWalkHeight'];

/** The eave (and mansard/gambrel) settings of a config, to pass on to the roof builders. */
function pickEaveConfig(config) {
  return Object.fromEntries([...EAVE_CONFIG_KEYS, ...TWO_SLOPE_CONFIG_KEYS].filter((key) => config[key] !== undefined).map((key) => [key, config[key]]));
}

/** Sides of each volume that touch another volume (no overhang there). */
function adjacentSidesByVolume(volumes, plates) {
  const sides = new Map(volumes.map((volume) => [volume.id, new Map()]));
  const byId = new Map(volumes.map((volume) => [volume.id, volume]));
  findVolumeAdjacencies(volumes).forEach((adjacency) => {
    const plate = (id) => plates?.[id] ?? 0;
    const link = (id, side, neighborId) => {
      const bySide = sides.get(id);
      if (!bySide) {
        return;
      }
      if (!bySide.has(side)) {
        bySide.set(side, []);
      }
      const neighbor = byId.get(neighborId);
      const acrossX = side === 'minX' || side === 'maxX';
      bySide.get(side).push({
        min: adjacency.overlapMin,
        max: adjacency.overlapMax,
        // the neighbor's whole wall face, which closes anything up against it
        wall: neighbor.outline
          ? outlineWallAlong(neighbor.outline, acrossX ? 0 : 1, byId.get(id)[side])
          : acrossX ? [neighbor.minZ, neighbor.maxZ] : [neighbor.minX, neighbor.maxX],
        // the neighbor's wall backs an eave end only if it reaches up to this roof's plate
        backs: plate(neighborId) >= plate(id) - 1e-6,
        // a lower neighbor stops below this roof's eave, which runs on over it
        below: plate(neighborId) < plate(id) - 1e-6,
        neighborId,
      });
    };
    link(adjacency.volumeAId, adjacency.sideA, adjacency.volumeBId);
    link(adjacency.volumeBId, adjacency.sideB, adjacency.volumeAId);
  });
  return sides;
}

/**
 * The extent of a cut volume's walls on the line where coordinate `k` (0 for
 * x, 1 for z) is `value`, along the other axis: its rectangle less what its
 * angled walls cut away.
 */
function outlineWallAlong(outline, k, value) {
  const along = outline.flatMap((a, i) => {
    const b = outline[(i + 1) % outline.length];
    return Math.abs(a[k] - value) < 1e-6 && Math.abs(b[k] - value) < 1e-6 ? [a[1 - k], b[1 - k]] : [];
  });
  return along.length ? [Math.min(...along), Math.max(...along)] : [0, 0];
}

/**
 * Overhang and eave settings for one volume's roof. Shared walls and merged
 * sides never overhang along their shared length; the exposed remainder of a
 * partly shared eave side gets its own eave strip (`eaves.partial`), and
 * `eaves.backing` lists neighbor walls that already close an eave end.
 */
function volumeEaveSetup(volumeId, roofType, orientation, config, mergedSides, adjacency, bounds) {
  const eaves = resolveVolumeEaves(volumeId, config);
  // only neighbors reaching up to this roof share the side: over a lower one the eave runs on
  const sharing = new Map([...(adjacency ?? new Map())]
    .map(([side, links]) => [side, links.filter((link) => !link.below)])
    .filter(([, links]) => links.length));
  const zeroSides = new Set([...sharing.keys(), ...(mergedSides ?? [])]);
  const { overhang, roles } = sideOverhangs(roofType, orientation, eaves, zeroSides);
  const backing = {};
  const partial = {};
  sharing.forEach((links, side) => {
    const covered = links.filter((link) => link.backs);
    if (covered.length) {
      backing[side] = [Math.min(...covered.map((link) => link.wall[0])), Math.max(...covered.map((link) => link.wall[1]))];
    }
    if (roles[side] !== 'eave' || !bounds || (mergedSides ?? []).includes(side) || !['gable', 'shed'].includes(roofType) || eaves.eaveDepth <= 1e-9) {
      return;
    }
    const alongX = side === 'minZ' || side === 'maxZ';
    const [lo, hi] = alongX ? [bounds.minX, bounds.maxX] : [bounds.minZ, bounds.maxZ];
    const sorted = links.map((link) => [link.min, link.max]).sort((x, y) => x[0] - y[0]);
    const intervals = [];
    let cursor = lo;
    sorted.forEach(([min, max]) => {
      if (min > cursor + 1e-6) {
        intervals.push({ a0: cursor, a1: min });
      }
      cursor = Math.max(cursor, max);
    });
    if (hi > cursor + 1e-6) {
      intervals.push({ a0: cursor, a1: hi });
    }
    const wallTouching = (t) => links.some((link) => link.backs && (Math.abs(link.max - t) < 1e-6 || Math.abs(link.min - t) < 1e-6));
    if (intervals.length) {
      partial[side] = intervals.map((interval) => ({
        ...interval, cap0: !wallTouching(interval.a0), cap1: !wallTouching(interval.a1),
      }));
    }
  });
  return { overhang, eaves: { ...eaves, backing, partial } };
}

/**
 * Overhang setup for every volume. A roof keeps its eave along a side that
 * another gable merges into (the merging roof abuts it, see `eaveAbutments`),
 * instead of losing the overhang along the shared wall.
 */
function buildRoofSetups(roofVolumes, config, connections, adjacentSides, roofTypeOf) {
  const absorbed = new Map(roofVolumes.map((volume) => [volume.id, new Set()]));
  findVolumeAdjacencies(roofVolumes).forEach(({
    volumeAId, sideA, volumeBId, sideB,
  }) => {
    [[volumeAId, sideA, volumeBId, sideB], [volumeBId, sideB, volumeAId, sideA]].forEach(([own, ownSide, other, otherSide]) => {
      if (connections.get(own)?.[ownSide]?.gableEnd) {
        absorbed.get(other).add(otherSide);
      }
    });
  });
  return new Map(roofVolumes.map((volume) => {
    const adjacency = adjacentSides.get(volume.id);
    const remaining = adjacency
      ? new Map([...adjacency].filter(([side]) => !absorbed.get(volume.id).has(side)))
      : undefined;
    return [volume.id, volumeEaveSetup(
      volume.id,
      roofTypeOf(volume),
      { ridgeAxis: volume.ridgeAxis, roofHighEdge: volume.roofHighEdge ?? defaultHighEdgeForAxis(volume.ridgeAxis) },
      config,
      Object.keys(connections.get(volume.id) ?? {}),
      remaining,
      { minX: volume.minX, maxX: volume.maxX, minZ: volume.minZ, maxZ: volume.maxZ }
    )];
  }));
}

/** Eave depth/slope of the roofs a merged gable's ends abut, keyed by end. */
function eaveAbutments(volumeConnections, setups, plates, ownId) {
  const abut = {};
  Object.values(volumeConnections ?? {}).forEach((resolution) => {
    // only an eave at the same height continues the merging roof's; a higher
    // one (a taller neighbor's) leaves this eave to run on to the wall
    const level = !plates || Math.abs((plates[resolution.neighborId] ?? 0) - (plates[ownId] ?? 0)) < 1e-6;
    if (resolution.gableEnd && resolution.neighborId && level) {
      const depth = setups.get(resolution.neighborId)?.overhang?.[resolution.neighborSide] ?? 0;
      if (depth > 1e-9) {
        abut[resolution.gableEnd] = { depth, slope: resolution.facingSlope };
      }
    }
  });
  return abut;
}

/** Per-side overhang from `config.overhang`, or a uniform scalar `roofOverhang`. */
function overhangOf(config) {
  if (config.overhang) {
    return { minX: 0, maxX: 0, minZ: 0, maxZ: 0, ...config.overhang };
  }
  const o = config.roofOverhang ?? 0;
  return { minX: o, maxX: o, minZ: o, maxZ: o };
}

function appendTriangles(positions, indices, triangles) {
  triangles.forEach((triangle) => {
    const first = positions.length / 3;
    triangle.forEach((vertex) => positions.push(...vertex));
    indices.push(first, first + 1, first + 2);
  });
}

function createGableRoofGeometry(bounds, config) {
  const ov = overhangOf(config);
  const axis = config.roofDirection === 'x' ? 'x' : 'z';
  const [cMin, cMax] = axis === 'x' ? [bounds.minZ, bounds.maxZ] : [bounds.minX, bounds.maxX];
  const [aMin, aMax] = axis === 'x' ? [bounds.minX, bounds.maxX] : [bounds.minZ, bounds.maxZ];
  const [eMin, eMax] = axis === 'x' ? [ov.minZ, ov.maxZ] : [ov.minX, ov.maxX];
  const [rStart, rEnd] = axis === 'x' ? [ov.minX, ov.maxX] : [ov.minZ, ov.maxZ];
  const centerCross = (cMin + cMax) / 2;
  const peakY = config.roofHeight;
  const halfSpan = (cMax - cMin) / 2;
  // The slopes keep their pitch past the wall, so an eave edge sits below the plate.
  const slope = halfSpan > 1e-9 ? peakY / halfSpan : 0;
  const yLow = -slope * eMin;
  const yHigh = -slope * eMax;
  const aStart = aMin - rStart;
  const aEnd = aMax + rEnd;
  // Where a merged end abuts the eave of the roof it merges into, the slope's
  // eave corner sits on the valley with that roof's plane (inset from the wall).
  const abut = config.abut ?? {};
  const insetFor = (end, eave) => (abut[end] && eave > 1e-9 && slope > 0
    ? Math.min(abut[end].depth, (slope * eave) / abut[end].slope)
    : 0);
  const insets = {
    start: [insetFor('start', eMin), insetFor('start', eMax)],
    end: [insetFor('end', eMin), insetFor('end', eMax)],
  };
  const W = axis === 'x' ? (c, a, y) => [a, y, c] : (c, a, y) => [c, y, a];
  const ridgeEndpoints = config.ridgeEndpoints;
  const startPeakY = ridgeEndpoints?.start?.[2] ?? peakY;
  const endPeakY = ridgeEndpoints?.end?.[2] ?? peakY;
  const corners = axis === 'x'
    ? [
      W(cMin - eMin, aStart + insets.start[0], yLow), W(cMin - eMin, aEnd - insets.end[0], yLow),
      W(cMax + eMax, aEnd - insets.end[1], yHigh), W(cMax + eMax, aStart + insets.start[1], yHigh),
    ]
    : [
      W(cMin - eMin, aStart + insets.start[0], yLow), W(cMax + eMax, aStart + insets.start[1], yHigh),
      W(cMax + eMax, aEnd - insets.end[1], yHigh), W(cMin - eMin, aEnd - insets.end[0], yLow),
    ];
  const ridgeStart = ridgeEndpoints?.start
    ? [ridgeEndpoints.start[0], startPeakY, ridgeEndpoints.start[1]]
    : W(centerCross, aStart, peakY);
  const ridgeEnd = ridgeEndpoints?.end
    ? [ridgeEndpoints.end[0], endPeakY, ridgeEndpoints.end[1]]
    : W(centerCross, aEnd, peakY);
  const positions = [...corners, ridgeStart, ridgeEnd].flat();
  // gable end faces stay at the wall plane; only the slopes run out past them
  [W(cMin, aMin, 0), W(cMax, aMin, 0), W(centerCross, aMin, startPeakY),
    W(cMin, aMax, 0), W(cMax, aMax, 0), W(centerCross, aMax, endPeakY)].forEach((v) => positions.push(...v));
  const slopes = axis === 'x'
    ? [0, 1, 5, 0, 5, 4, 3, 4, 5, 3, 5, 2]
    : [0, 4, 5, 0, 5, 3, 1, 2, 5, 1, 5, 4];
  // A merged end has no gable-end face: the ridge runs on into the
  // neighbor's roof, so the two slopes simply continue to their valley lines.
  const indices = [
    ...slopes,
    ...(config.mergedEnds?.start ? [] : [6, 7, 8]),
    ...(config.mergedEnds?.end ? [] : [9, 10, 11]),
  ];
  if (config.eaves) {
    appendTriangles(positions, indices, buildGableTrim(bounds, {
      roofHeight: peakY, ridgeAxis: axis, overhang: ov, eaves: config.eaves, insets,
    }));
    const eaveSlopes = axis === 'x' ? { minZ: slope, maxZ: slope } : { minX: slope, maxX: slope };
    appendTriangles(positions, indices, buildPartialEaveStrips(bounds, eaveSlopes, config.eaves));
  }
  return createIndexedGeometry(positions, indices);
}

function shedHighEdge(config) {
  const requested = config.roofHighEdge ?? defaultHighEdgeForAxis(config.roofDirection);
  // anything that is not a recognised edge has always meant 'z-max' here
  return ['x-min', 'x-max', 'z-min', 'z-max'].includes(requested) ? requested : 'z-max';
}

export function createShedRoofGeometry(bounds, config) {
  const { minX, maxX, minZ, maxZ } = bounds;
  const ov = overhangOf(config);
  const peakY = config.roofHeight;
  const highEdge = shedHighEdge(config);
  const cornerDefs = highEdge === 'x-min'
    ? [
      { x: minX, z: minZ, height: peakY, sides: ['minX', 'minZ'] },
      { x: maxX, z: minZ, height: 0, sides: ['maxX', 'minZ'] },
      { x: maxX, z: maxZ, height: 0, sides: ['maxX', 'maxZ'] },
      { x: minX, z: maxZ, height: peakY, sides: ['minX', 'maxZ'] },
    ]
    : highEdge === 'x-max'
      ? [
        { x: minX, z: minZ, height: 0, sides: ['minX', 'minZ'] },
        { x: maxX, z: minZ, height: peakY, sides: ['maxX', 'minZ'] },
        { x: maxX, z: maxZ, height: peakY, sides: ['maxX', 'maxZ'] },
        { x: minX, z: maxZ, height: 0, sides: ['minX', 'maxZ'] },
      ]
      : highEdge === 'z-min'
        ? [
          { x: minX, z: minZ, height: peakY, sides: ['minX', 'minZ'] },
          { x: maxX, z: minZ, height: peakY, sides: ['maxX', 'minZ'] },
          { x: maxX, z: maxZ, height: 0, sides: ['maxX', 'maxZ'] },
          { x: minX, z: maxZ, height: 0, sides: ['minX', 'maxZ'] },
        ]
        : [
          { x: minX, z: minZ, height: 0, sides: ['minX', 'minZ'] },
          { x: maxX, z: minZ, height: 0, sides: ['maxX', 'minZ'] },
          { x: maxX, z: maxZ, height: peakY, sides: ['maxX', 'maxZ'] },
          { x: minX, z: maxZ, height: peakY, sides: ['minX', 'maxZ'] },
        ];

  // A side merges into a neighbor only when resolveRoofConnections found a
  // connection for it (see its docstring for the two cases). Every merged
  // side's corners get repositioned to the neighbor's height; only a truly
  // coplanar merge (the neighbor's own surface is already at that height
  // right there) also skips the vertical/triangular closure — a ridge-snap
  // connection is a real vertical rise with nothing behind it, so its
  // closure stays, just built to the new, taller height (like a knee wall
  // closing the gap between a lean-to's own wall and the taller roof it
  // ties into).
  const connections = config.connections ?? {};
  const mergedSides = new Set(
    Object.keys(connections).filter((side) => connections[side]?.mode === 'merged' && !connections[side]?.rakeTriangle)
  );
  const closureSuppressedSides = new Set(
    Object.keys(connections).filter((side) => connections[side]?.mode === 'merged' && connections[side]?.suppressClosure)
  );

  const corners = cornerDefs.map((corner) => {
    const mergingSides = corner.sides.filter((side) => mergedSides.has(side));
    if (mergingSides.length === 0 || corner.height <= 1e-8) {
      return corner;
    }
    // An `override` connection (snap-ridge) deterministically replaces this
    // corner's height with a plane derived to pass through the neighbor's
    // own ridge, rather than merely capping our own configured height.
    const overrideSide = mergingSides.find((side) => connections[side].override);
    if (overrideSide) {
      return { ...corner, height: evalZoneHeight(connections[overrideSide].neighborPlanes, corner.x, corner.z) };
    }
    const clampedHeight = mergingSides.reduce(
      (height, side) => Math.min(height, evalZoneHeight(connections[side].neighborPlanes, corner.x, corner.z)),
      corner.height
    );
    return { ...corner, height: clampedHeight };
  });

  const positions = corners.flatMap((corner) => [corner.x, corner.height, corner.z]);
  corners.forEach((corner) => positions.push(corner.x, 0, corner.z));

  // Top surface: the corner quad, or — with overhang — the same plane
  // continued out to the expanded outline (closures stay at the wall plane).
  let indices = [0, 1, 2, 0, 2, 3];
  if (Object.values(ov).some((value) => value > 1e-9)) {
    const planes = computeVolumeEavePlanes(bounds, 'shed', {
      roofHeight: peakY, roofHighEdge: highEdge, roofDirection: config.roofDirection,
    });
    const first = positions.length / 3;
    corners.forEach((corner) => {
      const dx = corner.sides.includes('minX') ? -ov.minX : ov.maxX;
      const dz = corner.sides.includes('minZ') ? -ov.minZ : ov.maxZ;
      const height = dx === 0 && dz === 0 ? corner.height : evalZoneHeight(planes, corner.x + dx, corner.z + dz);
      positions.push(corner.x + dx, height, corner.z + dz);
    });
    indices = [first, first + 1, first + 2, first, first + 2, first + 3];
  }
  for (let index = 0; index < 4; index += 1) {
    const next = (index + 1) % 4;
    const edgeSide = cornerDefs[index].sides.find((side) => cornerDefs[next].sides.includes(side));
    if (closureSuppressedSides.has(edgeSide)) {
      continue;
    }
    const height = corners[index].height;
    const nextHeight = corners[next].height;
    if (height > 1e-8 && nextHeight > 1e-8) {
      indices.push(index, next, next + 4, index, next + 4, index + 4);
    } else if (height > 1e-8) {
      indices.push(index, next, index + 4);
    } else if (nextHeight > 1e-8) {
      indices.push(index, next, next + 4);
    }
  }
  Object.values(connections).forEach((resolution) => {
    if (resolution?.rakeTriangle) {
      const first = positions.length / 3;
      resolution.rakeTriangle.forEach((vertex) => positions.push(...vertex));
      indices.push(first, first + 1, first + 2);
    }
  });
  if (config.eaves) {
    appendTriangles(positions, indices, buildShedTrim(bounds, {
      roofHeight: peakY, roofHighEdge: highEdge, overhang: ov, eaves: config.eaves,
    }));
    const lowSide = { 'x-min': 'maxX', 'x-max': 'minX', 'z-min': 'maxZ', 'z-max': 'minZ' }[highEdge];
    const shedSpan = lowSide === 'minX' || lowSide === 'maxX' ? maxX - minX : maxZ - minZ;
    appendTriangles(positions, indices, buildPartialEaveStrips(bounds, { [lowSide]: shedSpan > 1e-9 ? peakY / shedSpan : 0 }, config.eaves));
  }
  return createIndexedGeometry(positions, indices);
}

/** Defaults for the two-slope roofs, per type (pitches are rise per 12 run). */
export const TWO_SLOPE_DEFAULTS = Object.freeze({
  mansard: Object.freeze({ breakHeight: 2.4, lowerPitchRise: 30, upperPitchRise: 4 }),
  gambrel: Object.freeze({ breakHeight: 2.4, lowerPitchRise: 20, upperPitchRise: 6 }),
});

const isTwoSlope = (roofType) => TWO_SLOPE_ROOF_TYPES.includes(roofType);

/**
 * A mansard's or gambrel's break height and slopes: the volume's own
 * (`volumeRoofShapes[id]`: `breakHeight`, `lowerPitchRise`, `upperPitchRise`)
 * over the building defaults (`roofBreakHeight`, `roofLowerPitchRise`,
 * `roofUpperPitchRise`) over the type's defaults. `unslopedSides` are closed
 * with end faces instead of sloping (see unslopedSidesOf).
 */
function twoSlopeConfig(volumeId, roofType, config, unslopedSides = []) {
  const defaults = TWO_SLOPE_DEFAULTS[roofType];
  const own = config.volumeRoofShapes?.[volumeId] ?? {};
  const run = config.roofPitchRun ?? 12;
  const pick = (key, buildingKey) => (Number.isFinite(own[key]) ? own[key] : config[buildingKey] ?? defaults[key]);
  return {
    breakHeight: pick('breakHeight', 'roofBreakHeight'),
    lowerSlope: pick('lowerPitchRise', 'roofLowerPitchRise') / run,
    upperSlope: pick('upperPitchRise', 'roofUpperPitchRise') / run,
    unslopedSides,
  };
}

/**
 * The sides of a volume that other volumes' walls cover along their whole
 * length and rise past (at least to this roof's plate): a two-slope roof
 * leaves them unsloped, closing them with an end face, rather than sloping
 * down into its neighbor. A side only partly covered keeps sloping (a U's
 * courtyard side), and the neighbor's own end face closes against it.
 */
function unslopedSidesOf(adjacency, bounds) {
  return [...(adjacency ?? new Map())].filter(([side, links]) => {
    const [lo, hi] = side === 'minX' || side === 'maxX' ? [bounds.minZ, bounds.maxZ] : [bounds.minX, bounds.maxX];
    const covered = links.filter((link) => link.backs).map((link) => [link.min, link.max]).sort((a, b) => a[0] - b[0]);
    let reach = lo;
    covered.forEach(([min, max]) => {
      if (min <= reach + 1e-6) {
        reach = Math.max(reach, max);
      }
    });
    return reach >= hi - 1e-6;
  }).map(([side]) => side);
}

/**
 * The roof config of a mansard or gambrel volume: its two-slope settings and
 * the peak height they reach (see roofPeak).
 */
function withTwoSlope(roofConfig, volumeId, roofType, config, bounds, unslopedSides) {
  const twoSlope = { ...roofConfig, ...twoSlopeConfig(volumeId, roofType, config, unslopedSides) };
  const planes = computeVolumeEavePlanes(bounds, roofType, twoSlope);
  const rectangle = [[bounds.minX, bounds.minZ], [bounds.maxX, bounds.minZ], [bounds.maxX, bounds.maxZ], [bounds.minX, bounds.maxZ]];
  return { ...twoSlope, roofHeight: planes.length ? roofPeak(planes, rectangle) : 0 };
}

/**
 * The solids of the neighbors across a two-slope roof's unsloped sides, in
 * the roof's own frame (its plate at y = 0), keyed by side: its end face there
 * keeps only the part standing clear of the neighbor's walls and roof.
 */
function neighborSolidsForEnds(volume, unslopedSides, roofVolumes, config, adjacentSides, plateOf = () => 0) {
  const solids = {};
  unslopedSides.forEach((side) => {
    const links = findVolumeAdjacencies(roofVolumes).filter((adjacency) => (
      (adjacency.volumeAId === volume.id && adjacency.sideA === side) || (adjacency.volumeBId === volume.id && adjacency.sideB === side)
    ));
    solids[side] = links.map((adjacency) => {
      const neighbor = roofVolumes.find((candidate) => candidate.id === (adjacency.volumeAId === volume.id ? adjacency.volumeBId : adjacency.volumeAId));
      const { bounds, roofType, planeConfig } = volumePlaneConfig(neighbor, config, adjacentSides);
      return volumeSolid({
        bounds,
        baseY: plateOf(neighbor.id) - plateOf(volume.id),
        planes: computeVolumeEavePlanes(bounds, roofType, planeConfig),
        slabThickness: roofType === 'flat' ? FLAT_ROOF_THICKNESS : 0,
      }, { floorY: -1e3 });
    });
  });
  return solids;
}

/**
 * The planes-defining config of a volume's own (unmerged) roof: what a
 * neighbor needs to know its shape (see resolveRoofConnections and
 * neighborSolidsForEnds).
 */
function volumePlaneConfig(volume, config, adjacentSides) {
  const roofType = config.volumeRoofTypes?.[volume.id] ?? config.roofType;
  const bounds = { minX: volume.minX, maxX: volume.maxX, minZ: volume.minZ, maxZ: volume.maxZ };
  const params = volumeRoofParams(volume.id, halfSpanForBounds(bounds, volume.ridgeAxis), config);
  let planeConfig = {
    roofDirection: volume.ridgeAxis,
    roofHighEdge: volume.roofHighEdge ?? defaultHighEdgeForAxis(volume.ridgeAxis),
    roofHeight: roofType === 'flat' ? 0 : params.roofHeight,
    roofPitchRise: params.pitchRise,
    roofPitchRun: params.pitchRun,
  };
  if (isTwoSlope(roofType)) {
    planeConfig = withTwoSlope(planeConfig, volume.id, roofType, config, bounds, unslopedSidesOf(adjacentSides?.get(volume.id), bounds));
  } else if (roofType === 'hip') {
    planeConfig = withHipWalk(planeConfig, volume.id, config);
  }
  return { bounds, roofType, planeConfig };
}

/** The wall segment of a rectangle side, as two plan points in ascending order. */
function sideSegment(bounds, side) {
  return side === 'minX' || side === 'maxX'
    ? [[bounds[side], bounds.minZ], [bounds[side], bounds.maxZ]]
    : [[bounds.minX, bounds[side]], [bounds.maxX, bounds[side]]];
}

/**
 * The faces of a min-of-planes roof over a rectangle: each plane over the
 * part of it where that plane is the lowest (exact convex clips).
 */
function minOfPlanesFaces(bounds, planes) {
  const rectangle = [[bounds.minX, bounds.minZ], [bounds.maxX, bounds.minZ], [bounds.maxX, bounds.maxZ], [bounds.minX, bounds.maxZ]];
  const triangles = [];
  planes.forEach((plane, i) => {
    let face = rectangle;
    planes.forEach((other, k) => {
      if (k !== i && face.length >= 3) {
        // identical planes (a flat upper tier) belong to the first of them
        const bias = k < i ? 1e-9 : 0;
        face = clipPolygon(face, ([x, z]) => evalPlaneHeight(other, x, z) - evalPlaneHeight(plane, x, z) - bias);
      }
    });
    if (face.length >= 3) {
      triangles.push(...polygonsToTriangles([face.map(([x, z]) => [x, evalPlaneHeight(plane, x, z), z])]));
    }
  });
  return triangles;
}

/**
 * The height of a hip's widow's walk (the flat top that replaces its ridge),
 * if it has one: the volume's own (`volumeRoofShapes[id].walkHeight`) or the
 * building's (`roofWalkHeight`).
 */
function hipWalkHeight(volumeId, config) {
  const own = config.volumeRoofShapes?.[volumeId]?.walkHeight;
  const walk = Number.isFinite(own) ? own : config.roofWalkHeight;
  return walk > 0 ? walk : undefined;
}

/** A hip roof config with its widow's walk, if any: the roof stops flat at the walk. */
function withHipWalk(roofConfig, volumeId, config) {
  const walkHeight = hipWalkHeight(volumeId, config);
  return walkHeight === undefined
    ? roofConfig
    : { ...roofConfig, walkHeight, roofHeight: Math.min(roofConfig.roofHeight, walkHeight) };
}

/**
 * A mansard or gambrel roof over a rectangle: the min of its planes (see
 * computeVolumeEavePlanes), built face by face, each plane over the part of
 * the rectangle where it is the lowest. Unsloped sides (gambrel ends, sides a
 * neighbor rises past) get an end face from the plate up to the roof, clipped
 * outside the neighbor's solid (`neighborSolids[side]`). Eaves are a
 * horizontal cornice box at the plate (top, fascia, flat soffit), mitred where
 * two meet; a gambrel's rakes carry the roof past the gable wall, with a
 * fascia and a soffit one fascia depth below the broken profile.
 */
function createTwoSlopeRoofGeometry(bounds, config) {
  const planes = computeVolumeEavePlanes(bounds, config.roofType, config);
  const ov = overhangOf(config);
  if (planes.length === 0) {
    return createFlatRoofGeometry(bounds, ov);
  }
  const ridgeAxis = config.roofDirection === 'x' ? 'x' : 'z';
  const sloped = twoSlopeSides(config.roofType, ridgeAxis, config.unslopedSides);
  const SIDES = ['minX', 'maxX', 'minZ', 'maxZ'];
  const unsloped = SIDES.filter((side) => !sloped.includes(side));
  const outward = (side) => (side === 'minX' || side === 'minZ' ? -1 : 1);
  const triangles = [];

  // the roof faces, carried past the walls under a rake
  const extended = { ...bounds };
  unsloped.forEach((side) => {
    extended[side] = bounds[side] + outward(side) * ov[side];
  });
  triangles.push(...minOfPlanesFaces(extended, planes));

  // end faces on the unsloped sides
  unsloped.forEach((side) => {
    const [a, b] = sideSegment(bounds, side);
    const top = roofProfile(planes, a, b).reverse().map(([t, height]) => [a[0] + (b[0] - a[0]) * t, height, a[1] + (b[1] - a[1]) * t]);
    let end = polygonsToTriangles([[[a[0], 0, a[1]], [b[0], 0, b[1]], ...top]]);
    (config.neighborSolids?.[side] ?? []).forEach((solid) => {
      end = clipOutsideConvexSolid(end, solid);
    });
    triangles.push(...end);
  });

  if (config.eaves) {
    triangles.push(...twoSlopeTrim(bounds, planes, sloped, ov, config.eaves));
  }
  return trianglesToGeometry(triangles);
}

/** Cornice boxes along a two-slope roof's eaves and rake boxes along its gable ends (see createTwoSlopeRoofGeometry). */
function twoSlopeTrim(bounds, planes, sloped, ov, eaves) {
  const f = eaves.fasciaDepth ?? 0;
  const SIDES = ['minX', 'maxX', 'minZ', 'maxZ'];
  const outward = (side) => (side === 'minX' || side === 'minZ' ? -1 : 1);
  const acrossX = (side) => side === 'minX' || side === 'maxX';
  const triangles = [];
  const quad = (a, b, c, d) => triangles.push([a, b, c], [a, c, d]);

  SIDES.filter((side) => sloped.includes(side) && ov[side] > 1e-9).forEach((side) => {
    const e = ov[side];
    const wall = bounds[side];
    const out = wall + outward(side) * e;
    // (along, cross, y) -> [x, y, z]; along runs the length of this side
    const P = acrossX(side) ? (t, c, y) => [c, y, t] : (t, c, y) => [t, y, c];
    const ends = acrossX(side) ? ['minZ', 'maxZ'] : ['minX', 'maxX'];
    const [inner, outer, capped] = [[], [], []];
    ends.forEach((end) => {
      const t = bounds[end];
      const reach = ov[end];
      if (sloped.includes(end) && reach > 1e-9) {
        inner.push(t);
        outer.push(t + outward(end) * reach); // mitred with the next eave
      } else if (!sloped.includes(end) && reach > 1e-9) {
        inner.push(t + outward(end) * reach); // runs on under the rake
        outer.push(t + outward(end) * reach);
        capped.push(t + outward(end) * reach);
      } else {
        inner.push(t);
        outer.push(t);
        const backing = eaves.backing?.[end];
        const covered = backing && Math.min(...backing) <= Math.min(wall, out) + 1e-9 && Math.max(...backing) >= Math.max(wall, out) - 1e-9;
        if (!covered) {
          capped.push(t);
        }
      }
    });
    quad(P(inner[0], wall, 0), P(inner[1], wall, 0), P(outer[1], out, 0), P(outer[0], out, 0));
    quad(P(outer[0], out, 0), P(outer[1], out, 0), P(outer[1], out, -f), P(outer[0], out, -f));
    quad(P(inner[0], wall, -f), P(inner[1], wall, -f), P(outer[1], out, -f), P(outer[0], out, -f));
    capped.forEach((t) => quad(P(t, wall, 0), P(t, out, 0), P(t, out, -f), P(t, wall, -f)));
  });

  SIDES.filter((side) => !sloped.includes(side) && ov[side] > 1e-9).forEach((side) => {
    const aWall = bounds[side];
    const aOut = aWall + outward(side) * ov[side];
    const [a, b] = sideSegment(bounds, side);
    // (across, t, y) -> [x, y, z]; t runs along the gable end
    const P = acrossX(side) ? (across, t, y) => [across, y, t] : (across, t, y) => [t, y, across];
    const k = acrossX(side) ? 1 : 0;
    const profile = roofProfile(planes, a, b).map(([t, height]) => [a[k] + (b[k] - a[k]) * t, height]);
    profile.slice(0, -1).forEach(([t0, h0], i) => {
      const [t1, h1] = profile[i + 1];
      quad(P(aOut, t0, h0), P(aOut, t1, h1), P(aOut, t1, h1 - f), P(aOut, t0, h0 - f));
      quad(P(aWall, t0, h0 - f), P(aWall, t1, h1 - f), P(aOut, t1, h1 - f), P(aOut, t0, h0 - f));
    });
    // a rake end that no eave box runs on under is boxed in
    const endSides = acrossX(side) ? ['minZ', 'maxZ'] : ['minX', 'maxX'];
    [[profile[0], endSides[0]], [profile[profile.length - 1], endSides[1]]].forEach(([[t, h], endSide]) => {
      if (!(sloped.includes(endSide) && ov[endSide] > 1e-9)) {
        quad(P(aWall, t, h), P(aOut, t, h), P(aOut, t, h - f), P(aWall, t, h - f));
      }
    });
  });
  return triangles;
}

function createHipRoofGeometry(bounds, config) {
  const ov = overhangOf(config);
  const e = Math.min(ov.minX, ov.maxX, ov.minZ, ov.maxZ);
  const planes = computeVolumeEavePlanes(bounds, 'hip', config);
  if (planes.some((plane) => plane.tier === 'walk')) {
    // cut flat at a widow's walk: the hip planes (carried past the walls) and the walk, face by face
    const outer = { minX: bounds.minX - e, maxX: bounds.maxX + e, minZ: bounds.minZ - e, maxZ: bounds.maxZ + e };
    const triangles = minOfPlanesFaces(outer, planes);
    if (config.eaves && e > 0) {
      triangles.push(...buildHipTrim(bounds, {
        pitchRatio: config.roofPitchRise / config.roofPitchRun, overhang: { minX: e, maxX: e, minZ: e, maxZ: e }, eaves: config.eaves,
      }));
    }
    return trianglesToGeometry(triangles);
  }
  const { minX, maxX, minZ, maxZ } = bounds;
  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const peakY = config.roofHeight;
  const pitchRatio = config.roofPitchRise / config.roofPitchRun;
  const longitudinalSpan = config.roofDirection === 'x' ? maxX - minX : maxZ - minZ;
  const ridgeEndOffset = Number.isFinite(pitchRatio) && pitchRatio > 0
    ? Math.min(longitudinalSpan / 2, peakY / pitchRatio)
    : 0;
  const eaveY = Number.isFinite(pitchRatio) ? -pitchRatio * e : 0;
  const ridgeEndpoints = config.ridgeEndpoints;
  const positions = config.roofDirection === 'x'
    ? [
      minX - e, eaveY, minZ - e, maxX + e, eaveY, minZ - e, maxX + e, eaveY, maxZ + e, minX - e, eaveY, maxZ + e,
      ridgeEndpoints?.start?.[0] ?? minX + ridgeEndOffset, peakY, ridgeEndpoints?.start?.[1] ?? centerZ,
      ridgeEndpoints?.end?.[0] ?? maxX - ridgeEndOffset, peakY, ridgeEndpoints?.end?.[1] ?? centerZ,
    ]
    : [
      minX - e, eaveY, minZ - e, maxX + e, eaveY, minZ - e, maxX + e, eaveY, maxZ + e, minX - e, eaveY, maxZ + e,
      ridgeEndpoints?.start?.[0] ?? centerX, peakY, ridgeEndpoints?.start?.[1] ?? minZ + ridgeEndOffset,
      ridgeEndpoints?.end?.[0] ?? centerX, peakY, ridgeEndpoints?.end?.[1] ?? maxZ - ridgeEndOffset,
    ];
  const indices = config.roofDirection === 'x'
    ? [0, 1, 5, 0, 5, 4, 3, 4, 5, 3, 5, 2, 0, 4, 3, 1, 2, 5]
    : [0, 4, 5, 0, 5, 3, 1, 2, 5, 1, 5, 4, 0, 1, 4, 3, 5, 2];
  if (config.eaves && e > 0) {
    appendTriangles(positions, indices, buildHipTrim(bounds, {
      pitchRatio: Number.isFinite(pitchRatio) ? pitchRatio : 0,
      overhang: { minX: e, maxX: e, minZ: e, maxZ: e },
      eaves: config.eaves,
    }));
  }
  return createIndexedGeometry(positions, indices);
}

function createIndexedGeometry(positions, indices) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function addFacadePanels(group, footprint, layout, foundationHeight, config) {
  layout.stories.forEach((story) => {
    layout.facadePanels.forEach((facadePanel) => {
      const [startX, startZ] = facadePanel.start;
      const [endX, endZ] = facadePanel.end;
      const { normal: [normalX, normalZ] } = wallRunFrame(facadePanel.start, facadePanel.end);
      const offset = 0.035;
      const minY = foundationHeight + story.minY + 0.02;
      const maxY = foundationHeight + story.maxY - 0.02;
      const positions = new Float32Array([
        startX + normalX * offset, minY, startZ + normalZ * offset,
        endX + normalX * offset, minY, endZ + normalZ * offset,
        endX + normalX * offset, maxY, endZ + normalZ * offset,
        startX + normalX * offset, maxY, startZ + normalZ * offset,
      ]);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setIndex([0, 1, 2, 0, 2, 3]);
      geometry.computeVertexNormals();

      const materialKey = config.panelMaterials?.[facadePanel.index]
        ?? config.storyMaterials?.[story.index]
        ?? config.wallMaterial
        ?? 'wood';
      const panel = new THREE.Mesh(geometry, paletteMaterial(materialKey, 'wall'));
      panel.userData = {
        facadeRegion: `${story.id}:${facadePanel.id}`,
        storyId: story.id,
        facadePanelId: facadePanel.id,
        material: materialKey,
        bodyPart: 'facade-panel',
      };
      group.add(panel);
    });
  });
}

function buildShape(footprint, overhang) {
  const shape = new THREE.Shape();
  const ring = footprint.map(([x, z]) => [x, -z]);

  if (ring.length === 0) {
    return shape;
  }

  const [firstX, firstZ] = ring[0];
  shape.moveTo(firstX, firstZ);
  for (let i = 1; i < ring.length; i += 1) {
    const [x, z] = ring[i];
    shape.lineTo(x, z);
  }

  if (overhang > 0) {
    const offset = new THREE.Shape();
    const offsets = footprint.map(([x, z]) => [
      x - (x / Math.hypot(x, z || 1)) * overhang,
      -(z - (z / Math.hypot(z, x || 1)) * overhang),
    ]);
    offset.moveTo(offsets[0][0], offsets[0][1]);
    for (let i = 1; i < offsets.length; i += 1) {
      offset.lineTo(offsets[i][0], offsets[i][1]);
    }
    return offset;
  }

  return shape;
}
