import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { getTerrainHeight } from './physics';
import { ColliderBox, ColliderCylinder, CourseGate } from './types';

export interface WorldBuildResult {
  boxes: ColliderBox[];
  cylinders: ColliderCylinder[];
  gates: CourseGate[];
}

// Custom FPV Action-Cam / O3 Barrel Distortion + Subtle Optical Vignette Shader
const FpvLensShader = {
  uniforms: {
    tDiffuse: { value: null },
    uDistortion: { value: 0.18 },
    uAspect: { value: 1.5 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uDistortion;
    uniform float uAspect;
    varying vec2 vUv;

    vec2 distort(vec2 uv, float k) {
      vec2 p = (uv - 0.5) * 2.0;
      p.x *= uAspect;
      float r2 = dot(p, p);
      // Brown-Conrady radial barrel distortion scaled to keep frame edges filled
      float zoom = 1.0 / (1.0 + k * 0.42);
      float f = (1.0 + k * r2 * 0.28) * zoom;
      p *= f;
      p.x /= uAspect;
      return p * 0.5 + 0.5;
    }

    void main() {
      float k = uDistortion;
      vec2 uvR = distort(vUv, k * 1.03);
      vec2 uvG = distort(vUv, k);
      vec2 uvB = distort(vUv, k * 0.97);

      if (uvG.x < 0.0 || uvG.x > 1.0 || uvG.y < 0.0 || uvG.y > 1.0) {
        gl_FragColor = vec4(0.02, 0.02, 0.03, 1.0);
        return;
      }

      float r = texture2D(tDiffuse, clamp(uvR, 0.0, 1.0)).r;
      float g = texture2D(tDiffuse, clamp(uvG, 0.0, 1.0)).g;
      float b = texture2D(tDiffuse, clamp(uvB, 0.0, 1.0)).b;

      // Subtle optical lens corner vignette
      vec2 d = vUv - 0.5;
      float vig = smoothstep(0.95, 0.35, length(d) * (1.0 + k * 0.65));
      vec3 col = vec3(r, g, b) * mix(1.0, vig, 0.24);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

function detectSoftwareWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
}

function createGrassTexture(maxAniso: number): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#3f5f37';
  ctx.fillRect(0, 0, size, size);

  // Subtle mowed airfield stripes
  for (let i = 0; i < 8; i++) {
    ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.045)';
    ctx.fillRect(i * (size / 8), 0, size / 8, size);
  }

  // Organic turf grain speckles
  for (let i = 0; i < 9000; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const shade = Math.random();
    ctx.fillStyle =
      shade > 0.65
        ? 'rgba(130, 165, 92, 0.22)'
        : shade > 0.3
        ? 'rgba(42, 68, 34, 0.25)'
        : 'rgba(105, 96, 68, 0.16)';
    ctx.fillRect(x, y, 2, 3);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(34, 34);
  tex.anisotropy = maxAniso;
  return tex;
}

function createConcreteTexture(maxAniso: number, withHelipad = false): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#7c8086';
  ctx.fillRect(0, 0, size, size);

  for (let i = 0; i < 4500; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const v = 100 + Math.floor(Math.random() * 55);
    ctx.fillStyle = `rgba(${v},${v},${v},0.18)`;
    ctx.fillRect(x, y, 3, 3);
  }

  // Expansion joint lines
  ctx.strokeStyle = 'rgba(30,32,36,0.28)';
  ctx.lineWidth = 3;
  ctx.strokeRect(4, 4, size - 8, size - 8);
  ctx.beginPath();
  ctx.moveTo(size / 2, 0);
  ctx.lineTo(size / 2, size);
  ctx.moveTo(0, size / 2);
  ctx.lineTo(size, size / 2);
  ctx.stroke();

  if (withHelipad) {
    // Painted amber/white FPV launch pad circle + H
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 18;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.37, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = '#f4f4f5';
    ctx.fillRect(size * 0.34, size * 0.28, size * 0.07, size * 0.44);
    ctx.fillRect(size * 0.59, size * 0.28, size * 0.07, size * 0.44);
    ctx.fillRect(size * 0.34, size * 0.465, size * 0.32, size * 0.07);

    // Direction arrow pointing North (-Z)
    ctx.fillStyle = '#f59e0b';
    ctx.beginPath();
    ctx.moveTo(size / 2, size * 0.06);
    ctx.lineTo(size * 0.56, size * 0.14);
    ctx.lineTo(size * 0.44, size * 0.14);
    ctx.closePath();
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = maxAniso;
  return tex;
}

function createGateBannerTexture(maxAniso: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#18181b';
  ctx.fillRect(0, 0, 512, 128);

  // Diagonal racing chevrons
  ctx.fillStyle = '#f59e0b';
  for (let x = -128; x < 640; x += 64) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + 30, 0);
    ctx.lineTo(x + 62, 128);
    ctx.lineTo(x + 32, 128);
    ctx.closePath();
    ctx.fill();
  }

  ctx.fillStyle = 'rgba(9, 9, 11, 0.72)';
  ctx.fillRect(0, 34, 512, 60);

  ctx.fillStyle = '#fafafa';
  ctx.font = '700 34px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('VEKTOR FPV  ·  RACE GATE', 256, 65);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAniso;
  return tex;
}

function createCorrugatedTexture(baseHex: string, maxAniso: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = baseHex;
  ctx.fillRect(0, 0, 256, 256);

  for (let x = 0; x < 256; x += 16) {
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(x, 0, 5, 256);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(x + 5, 0, 4, 256);
  }

  // Subtle industrial scuff marks
  for (let i = 0; i < 400; i++) {
    ctx.fillStyle = 'rgba(20,20,20,0.08)';
    ctx.fillRect(Math.random() * 256, Math.random() * 256, 8, 2);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 1);
  tex.anisotropy = maxAniso;
  return tex;
}

function createSkyDome(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(420, 32, 20);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTopColor: { value: new THREE.Color('#285999') },
      uMidColor: { value: new THREE.Color('#7db0dc') },
      uHorizonColor: { value: new THREE.Color('#d7e6f2') },
      uSunDir: { value: new THREE.Vector3(0.55, 0.45, -0.7).normalize() },
    },
    vertexShader: `
      varying vec3 vWorldPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform vec3 uTopColor;
      uniform vec3 uMidColor;
      uniform vec3 uHorizonColor;
      uniform vec3 uSunDir;
      varying vec3 vWorldPos;
      void main() {
        vec3 dir = normalize(vWorldPos);
        float h = clamp(dir.y, 0.0, 1.0);
        vec3 sky = mix(uHorizonColor, uMidColor, smoothstep(0.0, 0.28, h));
        sky = mix(sky, uTopColor, smoothstep(0.22, 0.85, h));
        float sunDot = max(dot(dir, uSunDir), 0.0);
        sky += vec3(1.0, 0.93, 0.78) * pow(sunDot, 16.0) * 0.22;
        sky += vec3(1.0, 0.98, 0.92) * pow(sunDot, 220.0) * 0.8;
        gl_FragColor = vec4(sky, 1.0);
      }
    `,
  });
  return new THREE.Mesh(geo, mat);
}

/**
 * Procedural Composite 5-inch FPV Freestyle Quadcopter (carbon X-frame, motors, props, LiPo, FPV pod)
 */
function createQuadcopterMesh(): {
  group: THREE.Group;
  propMeshes: THREE.Object3D[];
  propDiscs: THREE.Mesh[];
  statusLedMat: THREE.MeshStandardMaterial;
} {
  const group = new THREE.Group();

  const carbonMat = new THREE.MeshStandardMaterial({
    color: '#1b1d22',
    roughness: 0.36,
    metalness: 0.35,
  });
  const aluMat = new THREE.MeshStandardMaterial({
    color: '#d97706',
    roughness: 0.22,
    metalness: 0.88,
  });
  const motorBellMat = new THREE.MeshStandardMaterial({
    color: '#27272a',
    roughness: 0.25,
    metalness: 0.85,
  });
  const lipoMat = new THREE.MeshStandardMaterial({
    color: '#1e293b',
    roughness: 0.72,
    metalness: 0.05,
  });
  const propMat = new THREE.MeshStandardMaterial({
    color: '#f59e0b',
    roughness: 0.32,
    metalness: 0.1,
    transparent: true,
    opacity: 0.9,
  });
  const statusLedMat = new THREE.MeshStandardMaterial({
    color: '#f59e0b',
    emissive: '#f59e0b',
    emissiveIntensity: 1.8,
    roughness: 0.2,
  });

  // Main bottom carbon chassis + top plate
  const bottomPlate = new THREE.Mesh(new THREE.BoxGeometry(0.068, 0.005, 0.165), carbonMat);
  bottomPlate.position.y = 0;
  bottomPlate.castShadow = true;
  group.add(bottomPlate);

  const topPlate = new THREE.Mesh(new THREE.BoxGeometry(0.054, 0.004, 0.148), carbonMat);
  topPlate.position.y = 0.032;
  topPlate.castShadow = true;
  group.add(topPlate);

  // 4 anodized aluminum standoffs
  const standoffGeo = new THREE.CylinderGeometry(0.003, 0.003, 0.03, 8);
  const standoffCoords = [
    [0.022, -0.056],
    [-0.022, -0.056],
    [0.022, 0.056],
    [-0.022, 0.056],
  ];
  for (const [sx, sz] of standoffCoords) {
    const post = new THREE.Mesh(standoffGeo, aluMat);
    post.position.set(sx, 0.016, sz);
    group.add(post);
  }

  // 6S LiPo Battery Pack strapped on top
  const lipo = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.036, 0.088), lipoMat);
  lipo.position.set(0, 0.052, 0.016);
  lipo.castShadow = true;
  group.add(lipo);

  const strap = new THREE.Mesh(new THREE.BoxGeometry(0.046, 0.04, 0.018), aluMat);
  strap.position.set(0, 0.052, 0.016);
  group.add(strap);

  // FPV Camera Pod at nose (-Z)
  const camBody = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.024, 0.024), motorBellMat);
  camBody.position.set(0, 0.02, -0.072);
  camBody.rotation.x = 0.42;
  group.add(camBody);

  const lensRing = new THREE.Mesh(
    new THREE.CylinderGeometry(0.009, 0.009, 0.012, 16),
    new THREE.MeshStandardMaterial({ color: '#09090b', roughness: 0.1, metalness: 0.9 })
  );
  lensRing.rotation.x = Math.PI / 2 + 0.42;
  lensRing.position.set(0, 0.023, -0.084);
  group.add(lensRing);

  // Rear LED telemetry strip
  const ledBar = new THREE.Mesh(new THREE.BoxGeometry(0.048, 0.007, 0.006), statusLedMat);
  ledBar.position.set(0, 0.018, 0.082);
  group.add(ledBar);

  // 4 Carbon Arms + Motors + 3-Blade Propellers (M1:RR, M2:FR, M3:RL, M4:FL)
  const d = 0.115 * Math.SQRT1_2;
  const motorPos: [number, number][] = [
    [d, d], // M1 Rear-Right
    [d, -d], // M2 Front-Right
    [-d, d], // M3 Rear-Left
    [-d, -d], // M4 Front-Left
  ];

  const propMeshes: THREE.Object3D[] = [];
  const propDiscs: THREE.Mesh[] = [];
  const armGeo = new THREE.BoxGeometry(0.014, 0.006, 0.145);
  const bellGeo = new THREE.CylinderGeometry(0.0145, 0.0145, 0.018, 16);
  const hubGeo = new THREE.CylinderGeometry(0.0055, 0.0065, 0.01, 12);
  const bladeGeo = new THREE.BoxGeometry(0.012, 0.002, 0.062);
  const discGeo = new THREE.CylinderGeometry(0.0635, 0.0635, 0.002, 24);

  motorPos.forEach(([mx, mz], idx) => {
    // Diagonal carbon arm
    const arm = new THREE.Mesh(armGeo, carbonMat);
    arm.position.set(mx * 0.52, -0.002, mz * 0.52);
    arm.rotation.y = Math.atan2(mx, mz);
    arm.castShadow = true;
    group.add(arm);

    // Brushless motor bell
    const bell = new THREE.Mesh(bellGeo, motorBellMat);
    bell.position.set(mx, 0.011, mz);
    bell.castShadow = true;
    group.add(bell);

    // 3-blade propeller assembly
    const propGroup = new THREE.Group();
    propGroup.position.set(mx, 0.024, mz);

    const hub = new THREE.Mesh(hubGeo, aluMat);
    propGroup.add(hub);

    const bladeColorMat = idx === 1 || idx === 3 ? propMat : new THREE.MeshStandardMaterial({
      color: '#38bdf8',
      roughness: 0.3,
      metalness: 0.1,
      transparent: true,
      opacity: 0.9,
    });

    for (let b = 0; b < 3; b++) {
      const bladePivot = new THREE.Group();
      bladePivot.rotation.y = (b * Math.PI * 2) / 3;
      const blade = new THREE.Mesh(bladeGeo, bladeColorMat);
      blade.position.z = 0.032;
      blade.rotation.z = 0.22;
      bladePivot.add(blade);
      propGroup.add(bladePivot);
    }

    // Translucent spin blur disc
    const discMat = new THREE.MeshBasicMaterial({
      color: idx === 1 || idx === 3 ? '#f59e0b' : '#38bdf8',
      transparent: true,
      opacity: 0.0,
      depthWrite: false,
    });
    const disc = new THREE.Mesh(discGeo, discMat);
    disc.position.set(mx, 0.025, mz);
    group.add(disc);
    propDiscs.push(disc);

    group.add(propGroup);
    propMeshes.push(propGroup);
  });

  return { group, propMeshes, propDiscs, statusLedMat };
}

export class FpvWorld {
  public readonly renderer: THREE.WebGLRenderer;
  public readonly scene: THREE.Scene;
  public readonly camera: THREE.PerspectiveCamera;
  public readonly isSoftwareGl: boolean;
  public readonly worldData: WorldBuildResult;

  private composer: EffectComposer | null = null;
  private lensPass: ShaderPass | null = null;
  private sunLight: THREE.DirectionalLight;
  private droneMesh: THREE.Group;
  private propMeshes: THREE.Object3D[];
  private propDiscs: THREE.Mesh[];
  private statusLedMat: THREE.MeshStandardMaterial;
  private gateLedMats: THREE.MeshStandardMaterial[] = [];
  private windSockPivot: THREE.Group | null = null;
  private windSockCone: THREE.Mesh | null = null;

  // Chase camera damped state
  private chaseCamPos = new THREE.Vector3(0, 1.5, 3.2);
  private chaseLookAt = new THREE.Vector3(0, 0.5, 0);

  // Adaptive pixel ratio state (Apple Silicon iPad Air 60-120 FPS tuning)
  private currentPixelRatio: number;
  private maxPixelRatio: number;
  private fpsSamples = 0;
  private fpsAccum = 0;
  public measuredFps = 60;

  // Pre-allocated scratch math (Zero-GC in render loop)
  private readonly _camOffset = new THREE.Vector3();
  private readonly _tiltQuat = new THREE.Quaternion();
  private readonly _xAxis = new THREE.Vector3(1, 0, 0);
  private readonly _chaseDesired = new THREE.Vector3();
  private readonly _forward = new THREE.Vector3();

  constructor(container: HTMLElement) {
    this.isSoftwareGl = detectSoftwareWebGL();
    this.maxPixelRatio = this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    this.currentPixelRatio = this.maxPixelRatio;

    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    this.renderer.setPixelRatio(this.currentPixelRatio);
    this.renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#c8dceb');
    this.scene.fog = new THREE.FogExp2('#c8dceb', 0.0032);

    // Procedural Studio/Outdoor Environment Reflections (RoomEnvironment)
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();

    const aspect = (container.clientWidth || window.innerWidth) / Math.max(1, container.clientHeight || window.innerHeight);
    this.camera = new THREE.PerspectiveCamera(112, aspect, 0.045, 520);

    // Sky Dome
    this.scene.add(createSkyDome());

    // Warm Sunlight Key + Cool Sky/Ground Hemisphere Fill
    const hemi = new THREE.HemisphereLight('#a6cef5', '#4c593d', 0.85);
    this.scene.add(hemi);

    this.sunLight = new THREE.DirectionalLight('#fff2d6', 2.3);
    this.sunLight.position.set(70, 95, -60);
    this.sunLight.castShadow = !this.isSoftwareGl;
    this.sunLight.shadow.mapSize.set(1024, 1024);
    this.sunLight.shadow.camera.near = 10;
    this.sunLight.shadow.camera.far = 230;
    const d = 62;
    this.sunLight.shadow.camera.left = -d;
    this.sunLight.shadow.camera.right = d;
    this.sunLight.shadow.camera.top = d;
    this.sunLight.shadow.camera.bottom = -d;
    this.sunLight.shadow.bias = -0.0005;
    this.sunLight.shadow.normalBias = 0.03;
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);

    // Build FPV Training Arena
    this.worldData = this.buildTrainingPark();

    // Build Composite 5-Inch Quadcopter Mesh
    const quad = createQuadcopterMesh();
    this.droneMesh = quad.group;
    this.propMeshes = quad.propMeshes;
    this.propDiscs = quad.propDiscs;
    this.statusLedMat = quad.statusLedMat;
    this.scene.add(this.droneMesh);

    // Setup optional FPV Fisheye Post-Processing Composer (GPU only)
    if (!this.isSoftwareGl) {
      this.composer = new EffectComposer(this.renderer);
      this.composer.setPixelRatio(this.currentPixelRatio);
      this.composer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);

      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.lensPass = new ShaderPass(FpvLensShader);
      this.lensPass.uniforms.uAspect.value = aspect;
      this.composer.addPass(this.lensPass);
      this.composer.addPass(new OutputPass());

      // Pre-warm shaders once on real GPU
      this.renderer.compile(this.scene, this.camera);
    }
  }

  private buildTrainingPark(): WorldBuildResult {
    const boxes: ColliderBox[] = [];
    const cylinders: ColliderCylinder[] = [];
    const gates: CourseGate[] = [];
    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();

    // 1. Vast Rolling Terrain Mesh (560m x 560m extending smoothly to fog horizon)
    const terrainGeo = new THREE.PlaneGeometry(560, 560, 128, 128);
    terrainGeo.rotateX(-Math.PI / 2);
    const posAttr = terrainGeo.attributes.position;
    const colors = new Float32Array(posAttr.count * 3);
    const cMeadow = new THREE.Color('#5b7c47');
    const cHill = new THREE.Color('#4a693b');
    const cRock = new THREE.Color('#6f7378');
    const tmpCol = new THREE.Color();

    for (let i = 0; i < posAttr.count; i++) {
      const x = posAttr.getX(i);
      const z = posAttr.getZ(i);
      const y = getTerrainHeight(x, z);
      posAttr.setY(i, y);

      if (y > 14) {
        tmpCol.copy(cHill).lerp(cRock, THREE.MathUtils.clamp((y - 14) / 18, 0, 0.85));
      } else {
        tmpCol.copy(cMeadow).lerp(cHill, THREE.MathUtils.clamp(y / 14, 0, 1));
      }
      colors[i * 3] = tmpCol.r;
      colors[i * 3 + 1] = tmpCol.g;
      colors[i * 3 + 2] = tmpCol.b;
    }
    terrainGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    terrainGeo.computeVertexNormals();

    const grassTex = createGrassTexture(maxAniso);
    const terrainMat = new THREE.MeshStandardMaterial({
      map: grassTex,
      vertexColors: true,
      roughness: 0.92,
      metalness: 0.0,
    });
    const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
    terrainMesh.receiveShadow = true;
    this.scene.add(terrainMesh);

    // 2. Concrete Launch Pad with H-Helipad Markings (offset +0.025m Y to prevent Z-fighting)
    const padTex = createConcreteTexture(maxAniso, true);
    const padMesh = new THREE.Mesh(
      new THREE.BoxGeometry(6.5, 0.08, 6.5),
      new THREE.MeshStandardMaterial({
        map: padTex,
        roughness: 0.82,
        metalness: 0.05,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      })
    );
    padMesh.position.set(0, 0.01, 0);
    padMesh.receiveShadow = true;
    this.scene.add(padMesh);

    // Asphalt Pit Apron & Pilot Tent Shelter behind spawn
    const concreteTex = createConcreteTexture(maxAniso, false);
    const concreteMat = new THREE.MeshStandardMaterial({
      map: concreteTex,
      roughness: 0.88,
      metalness: 0.05,
    });
    const steelMat = new THREE.MeshStandardMaterial({
      color: '#3f3f46',
      roughness: 0.35,
      metalness: 0.78,
    });
    const accentAmberMat = new THREE.MeshStandardMaterial({
      color: '#f59e0b',
      roughness: 0.42,
      metalness: 0.2,
    });

    // 3. 10-Gate Flowing FPV Racing & Freestyle Circuit
    const gateLayout: Array<{ x: number; z: number; yawDeg: number; elev?: number; w?: number; h?: number }> = [
      { x: 0, z: -22, yawDeg: 0, w: 6.4, h: 4.8 },
      { x: 14, z: -48, yawDeg: -26, w: 6.2, h: 4.6 },
      { x: 42, z: -64, yawDeg: -65, elev: 3.2, w: 6.4, h: 4.8 }, // Raised Split-S / Powerloop Gate
      { x: 64, z: -36, yawDeg: -155, w: 6.2, h: 4.6 },
      { x: 52, z: 6, yawDeg: 175, w: 6.0, h: 4.6 },
      { x: 28, z: 36, yawDeg: 125, w: 6.2, h: 4.6 },
      { x: -12, z: 48, yawDeg: 95, elev: 2.5, w: 6.4, h: 4.8 },
      { x: -48, z: 30, yawDeg: 35, w: 6.2, h: 4.6 },
      { x: -56, z: -14, yawDeg: -10, w: 6.2, h: 4.6 },
      { x: -28, z: -42, yawDeg: -52, w: 6.4, h: 4.8 },
    ];

    const bannerTex = createGateBannerTexture(maxAniso);
    const bannerMat = new THREE.MeshStandardMaterial({
      map: bannerTex,
      roughness: 0.65,
      metalness: 0.05,
    });

    gateLayout.forEach((g, idx) => {
      const groundY = getTerrainHeight(g.x, g.z);
      const w = g.w ?? 6.2;
      const h = g.h ?? 4.6;
      const elev = g.elev ?? 0;
      const yawRad = THREE.MathUtils.degToRad(g.yawDeg);

      const gateGroup = new THREE.Group();
      gateGroup.position.set(g.x, groundY, g.z);
      gateGroup.rotation.y = yawRad;

      const pillarH = h + elev;
      const pillarGeo = new THREE.CylinderGeometry(0.14, 0.17, pillarH, 10);
      const baseGeo = new THREE.BoxGeometry(0.75, 0.24, 1.35);

      // Left & Right support pillars + grounded steel feet
      [-w / 2, w / 2].forEach((px) => {
        const pillar = new THREE.Mesh(pillarGeo, steelMat);
        pillar.position.set(px, pillarH / 2, 0);
        pillar.castShadow = true;
        gateGroup.add(pillar);

        const foot = new THREE.Mesh(baseGeo, accentAmberMat);
        foot.position.set(px, 0.12, 0);
        foot.castShadow = true;
        foot.receiveShadow = true;
        gateGroup.add(foot);
      });

      // Top Race Banner Crossbar
      const topBar = new THREE.Mesh(new THREE.BoxGeometry(w + 0.5, 0.78, 0.34), bannerMat);
      topBar.position.set(0, pillarH + 0.22, 0);
      topBar.castShadow = true;
      gateGroup.add(topBar);

      // Lower bar for elevated Split-S gates
      if (elev > 0.5) {
        const lowBar = new THREE.Mesh(new THREE.BoxGeometry(w, 0.32, 0.26), accentAmberMat);
        lowBar.position.set(0, elev, 0);
        lowBar.castShadow = true;
        gateGroup.add(lowBar);
      }

      // LED Gate Indicator Strips (inner left, right, top)
      const ledMat = new THREE.MeshStandardMaterial({
        color: idx === 0 ? '#f59e0b' : '#52525b',
        emissive: idx === 0 ? '#f59e0b' : '#18181b',
        emissiveIntensity: idx === 0 ? 2.0 : 0.2,
        roughness: 0.25,
      });
      this.gateLedMats.push(ledMat);

      const sideStripGeo = new THREE.BoxGeometry(0.09, h - 0.3, 0.18);
      const leftStrip = new THREE.Mesh(sideStripGeo, ledMat);
      leftStrip.position.set(-w / 2 + 0.16, elev + h / 2, 0);
      gateGroup.add(leftStrip);

      const rightStrip = new THREE.Mesh(sideStripGeo, ledMat);
      rightStrip.position.set(w / 2 - 0.16, elev + h / 2, 0);
      gateGroup.add(rightStrip);

      const topStrip = new THREE.Mesh(new THREE.BoxGeometry(w - 0.3, 0.12, 0.38), ledMat);
      topStrip.position.set(0, pillarH - 0.14, 0);
      gateGroup.add(topStrip);

      this.scene.add(gateGroup);

      // Register Gate Traversal Aperture
      gates.push({
        id: idx + 1,
        x: g.x,
        y: groundY + elev + h / 2,
        z: g.z,
        yawRad,
        width: w,
        height: h,
      });

      // Register Pillar Cylinder Colliders in world space
      const cosY = Math.cos(yawRad);
      const sinY = Math.sin(yawRad);
      [-w / 2, w / 2].forEach((px) => {
        const wx = g.x + px * cosY;
        const wz = g.z - px * sinY;
        cylinders.push({
          x: wx,
          z: wz,
          radius: 0.22,
          minY: groundY,
          maxY: groundY + pillarH + 0.6,
          label: `Tor ${idx + 1} Pfosten`,
        });
      });
    });

    // 4. Concrete Freestyle Dive Tower (at x = -22, z = -14) — 22m tall with open fly-through floors!
    const towerX = -22;
    const towerZ = -14;
    const towerBaseY = getTerrainHeight(towerX, towerZ);
    const towerGroup = new THREE.Group();
    towerGroup.position.set(towerX, towerBaseY, towerZ);

    const colSpan = 3.8;
    const towerH = 22;
    const colOffsets: [number, number][] = [
      [-colSpan, -colSpan],
      [colSpan, -colSpan],
      [-colSpan, colSpan],
      [colSpan, colSpan],
    ];
    colOffsets.forEach(([cx, cz]) => {
      const col = new THREE.Mesh(new THREE.BoxGeometry(0.95, towerH, 0.95), concreteMat);
      col.position.set(cx, towerH / 2, cz);
      col.castShadow = true;
      col.receiveShadow = true;
      towerGroup.add(col);

      boxes.push({
        minX: towerX + cx - 0.5,
        maxX: towerX + cx + 0.5,
        minY: towerBaseY,
        maxY: towerBaseY + towerH,
        minZ: towerZ + cz - 0.5,
        maxZ: towerZ + cz + 0.5,
        label: 'Dive-Tower Pfeiler',
      });
    });

    // Concrete deck slabs with wide fly-through heights (y=7.5m, 15m, 22m roof)
    [7.5, 15.0, 22.0].forEach((deckY) => {
      const slab = new THREE.Mesh(new THREE.BoxGeometry(colSpan * 2 + 1.5, 0.65, colSpan * 2 + 1.5), concreteMat);
      slab.position.set(0, deckY, 0);
      slab.castShadow = true;
      slab.receiveShadow = true;
      towerGroup.add(slab);

      // Amber edge trim on roof for clear visual reference during inverted dives
      if (deckY === 22.0) {
        const trim = new THREE.Mesh(new THREE.BoxGeometry(colSpan * 2 + 1.7, 0.24, colSpan * 2 + 1.7), accentAmberMat);
        trim.position.set(0, deckY + 0.36, 0);
        towerGroup.add(trim);
      }

      boxes.push({
        minX: towerX - colSpan - 0.75,
        maxX: towerX + colSpan + 0.75,
        minY: towerBaseY + deckY - 0.35,
        maxY: towerBaseY + deckY + 0.45,
        minZ: towerZ - colSpan - 0.75,
        maxZ: towerZ + colSpan + 0.75,
        label: 'Dive-Tower Plattform',
      });
    });
    this.scene.add(towerGroup);

    // 5. Industrial Shipping Containers (Freestyle Gap Obstacles)
    const containerDefs = [
      { x: 24, z: -12, yOff: 0, w: 2.6, h: 2.8, d: 7.4, color: '#9a3412', label: 'Container' },
      { x: 24, z: -23, yOff: 0, w: 2.6, h: 2.8, d: 7.4, color: '#1d4ed8', label: 'Container' },
      { x: 24, z: -17.5, yOff: 2.8, w: 2.6, h: 2.8, d: 9.0, color: '#3f6212', label: 'Container-Brücke' }, // Fly-under tunnel gap!
      { x: -10, z: 22, yOff: 0, w: 7.2, h: 2.8, d: 2.6, color: '#b45309', label: 'Container' },
      { x: 40, z: 22, yOff: 0, w: 2.6, h: 2.8, d: 7.4, color: '#334155', label: 'Container' },
    ];

    containerDefs.forEach((c) => {
      const gy = getTerrainHeight(c.x, c.z);
      const tex = createCorrugatedTexture(c.color, maxAniso);
      const mat = new THREE.MeshStandardMaterial({
        map: tex,
        roughness: 0.52,
        metalness: 0.45,
      });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(c.w, c.h, c.d), mat);
      mesh.position.set(c.x, gy + c.yOff + c.h / 2, c.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);

      boxes.push({
        minX: c.x - c.w / 2,
        maxX: c.x + c.w / 2,
        minY: gy + c.yOff,
        maxY: gy + c.yOff + c.h,
        minZ: c.z - c.d / 2,
        maxZ: c.z + c.d / 2,
        label: c.label,
      });
    });

    // 6. Slalom Flags (6 high-visibility racing flags along straightaway)
    const flagPositions: [number, number][] = [
      [10, 12],
      [14, 2],
      [10, -8],
      [-14, 6],
      [-20, 14],
      [-34, 4],
    ];
    const poleGeo = new THREE.CylinderGeometry(0.06, 0.08, 6.2, 8);
    const flagClothGeo = new THREE.BoxGeometry(0.9, 3.2, 0.05);
    const flagClothMat = new THREE.MeshStandardMaterial({
      color: '#ef4444',
      roughness: 0.72,
      metalness: 0.0,
    });

    flagPositions.forEach(([fx, fz]) => {
      const gy = getTerrainHeight(fx, fz);
      const grp = new THREE.Group();
      grp.position.set(fx, gy, fz);

      const pole = new THREE.Mesh(poleGeo, steelMat);
      pole.position.y = 3.1;
      pole.castShadow = true;
      grp.add(pole);

      const cloth = new THREE.Mesh(flagClothGeo, flagClothMat);
      cloth.position.set(0.48, 4.3, 0);
      cloth.castShadow = true;
      grp.add(cloth);

      this.scene.add(grp);
      cylinders.push({
        x: fx,
        z: fz,
        radius: 0.14,
        minY: gy,
        maxY: gy + 6.2,
        label: 'Slalom-Flagge',
      });
    });

    // 7. Live Reactive Windsock Mast beside Launch Pad
    const sockX = 8.5;
    const sockZ = -4.5;
    const sockY = getTerrainHeight(sockX, sockZ);
    const mastGroup = new THREE.Group();
    mastGroup.position.set(sockX, sockY, sockZ);

    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 5.2, 10), steelMat);
    mast.position.y = 2.6;
    mast.castShadow = true;
    mastGroup.add(mast);

    const sockPivot = new THREE.Group();
    sockPivot.position.y = 5.1;
    const sockGeo = new THREE.CylinderGeometry(0.14, 0.34, 2.2, 12, 1, true);
    sockGeo.rotateX(Math.PI / 2);
    sockGeo.translate(0, 0, 1.1);
    const sockMat = new THREE.MeshStandardMaterial({
      color: '#f97316',
      roughness: 0.65,
      side: THREE.DoubleSide,
    });
    const sockCone = new THREE.Mesh(sockGeo, sockMat);
    sockPivot.add(sockCone);
    mastGroup.add(sockPivot);
    this.scene.add(mastGroup);
    this.windSockPivot = sockPivot;
    this.windSockCone = sockCone;

    cylinders.push({
      x: sockX,
      z: sockZ,
      radius: 0.14,
      minY: sockY,
      maxY: sockY + 5.2,
      label: 'Windsack-Mast',
    });

    // 8. Instanced Alpine Pine Forest (~210 multi-tiered trees using 3 InstancedMeshes for Apple GPU speed)
    this.buildInstancedForest(gates, cylinders);

    // 9. Instanced Alpine Boulders along Perimeter Ridge
    this.buildInstancedBoulders();

    return { boxes, cylinders, gates };
  }

  private buildInstancedForest(gates: CourseGate[], cylinders: ColliderCylinder[]): void {
    // Deterministic pseudo-random generator for consistent course layout
    let seed = 4219;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };

    const treeSpots: Array<{ x: number; z: number; scale: number; rotY: number }> = [];
    const targetCount = 210;

    for (let attempt = 0; attempt < 950 && treeSpots.length < targetCount; attempt++) {
      const angle = rand() * Math.PI * 2;
      // Inner freestyle pockets + dense outer alpine forest perimeter
      const radius = attempt < 45 ? 24 + rand() * 56 : 72 + rand() * 140;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;

      // Keep launch pad, dive tower, containers, and race gates clear
      if (Math.hypot(x, z) < 16) continue;
      if (Math.hypot(x + 22, z + 14) < 12) continue;
      if (Math.hypot(x - 24, z + 17) < 14) continue;

      let nearGate = false;
      for (const g of gates) {
        if (Math.hypot(x - g.x, z - g.z) < 11.5) {
          nearGate = true;
          break;
        }
      }
      if (nearGate) continue;

      treeSpots.push({
        x,
        z,
        scale: 0.85 + rand() * 0.45,
        rotY: rand() * Math.PI * 2,
      });
    }

    const count = treeSpots.length;
    const trunkGeo = new THREE.CylinderGeometry(0.18, 0.34, 3.2, 7);
    trunkGeo.translate(0, 1.6, 0);
    const trunkMat = new THREE.MeshStandardMaterial({ color: '#4d3627', roughness: 0.94 });

    const foliageLowGeo = new THREE.ConeGeometry(2.5, 5.4, 7);
    foliageLowGeo.translate(0, 5.2, 0);
    const foliageTopGeo = new THREE.ConeGeometry(1.75, 4.6, 7);
    foliageTopGeo.translate(0, 8.2, 0);

    const foliageMat = new THREE.MeshStandardMaterial({
      color: '#ffffff', // Tinted per instance
      roughness: 0.86,
      metalness: 0.0,
    });

    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
    const lowCanopy = new THREE.InstancedMesh(foliageLowGeo, foliageMat, count);
    const topCanopy = new THREE.InstancedMesh(foliageTopGeo, foliageMat, count);

    trunks.castShadow = true;
    lowCanopy.castShadow = true;
    topCanopy.castShadow = true;
    lowCanopy.receiveShadow = true;

    const dummy = new THREE.Object3D();
    const tint = new THREE.Color();

    treeSpots.forEach((spot, i) => {
      const gy = getTerrainHeight(spot.x, spot.z);
      dummy.position.set(spot.x, gy - 0.15, spot.z);
      dummy.rotation.set(0, spot.rotY, 0);
      dummy.scale.setScalar(spot.scale);
      dummy.updateMatrix();

      trunks.setMatrixAt(i, dummy.matrix);
      lowCanopy.setMatrixAt(i, dummy.matrix);
      topCanopy.setMatrixAt(i, dummy.matrix);

      // Subtle natural forest color variation
      const hue = 0.28 + (rand() - 0.5) * 0.05;
      const sat = 0.36 + rand() * 0.14;
      const lit = 0.20 + rand() * 0.09;
      tint.setHSL(hue, sat, lit);
      lowCanopy.setColorAt(i, tint);
      tint.offsetHSL(0, 0.03, 0.04);
      topCanopy.setColorAt(i, tint);

      // Add trunk/canopy collider for trees inside playable zone
      if (Math.hypot(spot.x, spot.z) < 110) {
        cylinders.push({
          x: spot.x,
          z: spot.z,
          radius: 0.42 * spot.scale,
          minY: gy,
          maxY: gy + 9.5 * spot.scale,
          label: 'Baum',
        });
      }
    });

    trunks.instanceMatrix.needsUpdate = true;
    lowCanopy.instanceMatrix.needsUpdate = true;
    topCanopy.instanceMatrix.needsUpdate = true;
    if (lowCanopy.instanceColor) lowCanopy.instanceColor.needsUpdate = true;
    if (topCanopy.instanceColor) topCanopy.instanceColor.needsUpdate = true;

    trunks.computeBoundingSphere();
    lowCanopy.computeBoundingSphere();
    topCanopy.computeBoundingSphere();

    this.scene.add(trunks, lowCanopy, topCanopy);
  }

  private buildInstancedBoulders(): void {
    const count = 75;
    const rockGeo = new THREE.DodecahedronGeometry(1.4, 1);
    const rockMat = new THREE.MeshStandardMaterial({
      color: '#ffffff',
      roughness: 0.9,
      metalness: 0.05,
    });
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, count);
    rocks.receiveShadow = true;

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    let seed = 8813;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };

    for (let i = 0; i < count; i++) {
      const a = rand() * Math.PI * 2;
      const r = 82 + rand() * 145;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const gy = getTerrainHeight(x, z);

      dummy.position.set(x, gy + 0.25, z);
      dummy.rotation.set(rand() * Math.PI, rand() * Math.PI, rand() * Math.PI);
      dummy.scale.set(0.9 + rand() * 2.4, 0.6 + rand() * 1.4, 0.9 + rand() * 2.4);
      dummy.updateMatrix();
      rocks.setMatrixAt(i, dummy.matrix);

      const v = 0.42 + rand() * 0.22;
      color.setRGB(v, v * 0.98, v * 0.96);
      rocks.setColorAt(i, color);
    }

    rocks.instanceMatrix.needsUpdate = true;
    if (rocks.instanceColor) rocks.instanceColor.needsUpdate = true;
    rocks.computeBoundingSphere();
    this.scene.add(rocks);
  }

  public syncAndRender(params: {
    dt: number;
    dronePos: THREE.Vector3;
    droneQuat: THREE.Quaternion;
    motorSpeeds: readonly [number, number, number, number];
    armed: boolean;
    crashed: boolean;
    activeGateIndex: number;
    windSpeedMs: number;
    windDirDeg: number;
    cameraTiltDeg: number;
    cameraFovDeg: number;
    fisheyeStrength: number;
    viewMode: 'FPV' | 'CHASE';
    showPropsInFpv: boolean;
    adaptivePixelRatio: boolean;
  }): void {
    const {
      dt,
      dronePos,
      droneQuat,
      motorSpeeds,
      armed,
      crashed,
      activeGateIndex,
      windSpeedMs,
      windDirDeg,
      cameraTiltDeg,
      cameraFovDeg,
      fisheyeStrength,
      viewMode,
      showPropsInFpv,
      adaptivePixelRatio,
    } = params;

    // 1. Update Drone 3D Transform & Spinning Propellers
    this.droneMesh.position.copy(dronePos);
    this.droneMesh.quaternion.copy(droneQuat);

    // In FPV mode, show drone only if showPropsInFpv is enabled (camera sits just behind nose)
    this.droneMesh.visible = viewMode === 'CHASE' || showPropsInFpv;

    for (let i = 0; i < 4; i++) {
      const s = motorSpeeds[i];
      const spinDir = i === 1 || i === 2 ? -1 : 1;
      this.propMeshes[i].rotation.y += spinDir * (2 + s * 110) * dt;
      const discMat = this.propDiscs[i].material as THREE.MeshBasicMaterial;
      discMat.opacity = THREE.MathUtils.clamp((s - 0.1) * 0.42, 0, 0.34);
    }

    // Rear LED status color
    if (crashed) {
      this.statusLedMat.color.set('#ef4444');
      this.statusLedMat.emissive.set('#ef4444');
    } else if (armed) {
      this.statusLedMat.color.set('#06b6d4');
      this.statusLedMat.emissive.set('#06b6d4');
    } else {
      this.statusLedMat.color.set('#f59e0b');
      this.statusLedMat.emissive.set('#f59e0b');
    }

    // 2. Highlight Active Racing Gate LEDs
    for (let i = 0; i < this.gateLedMats.length; i++) {
      const isNext = i === activeGateIndex;
      const mat = this.gateLedMats[i];
      if (isNext) {
        mat.color.set('#f59e0b');
        mat.emissive.set('#f59e0b');
        mat.emissiveIntensity = 2.1;
      } else {
        mat.color.set('#52525b');
        mat.emissive.set('#09090b');
        mat.emissiveIntensity = 0.15;
      }
    }

    // 3. Animate Live Windsock
    if (this.windSockPivot && this.windSockCone) {
      const targetYaw = THREE.MathUtils.degToRad(windDirDeg);
      this.windSockPivot.rotation.y = THREE.MathUtils.damp(this.windSockPivot.rotation.y, targetYaw, 4, dt);
      // Droop when calm, stretch horizontal in strong wind
      const droop = THREE.MathUtils.clamp(1 - windSpeedMs / 8, 0.05, 0.92);
      this.windSockCone.rotation.x = THREE.MathUtils.damp(this.windSockCone.rotation.x, droop * 1.15, 5, dt);
    }

    // 4. Keep Shadow Frustum Centered Near Drone for Razor-Sharp Shadows Everywhere
    if (!this.isSoftwareGl) {
      this.sunLight.target.position.set(dronePos.x, 0, dronePos.z);
      this.sunLight.position.set(dronePos.x + 70, 95, dronePos.z - 60);
      this.sunLight.target.updateMatrixWorld();
    }

    // 5. Update Camera (FPV Cockpit vs Smooth Damped Chase Cam)
    if (Math.abs(this.camera.fov - cameraFovDeg) > 0.1) {
      this.camera.fov = cameraFovDeg;
      this.camera.updateProjectionMatrix();
    }

    if (viewMode === 'FPV') {
      // Mount FPV camera on nose with configurable upward tilt (0° to 55°)
      this._camOffset.set(0, 0.042, -0.058).applyQuaternion(droneQuat);
      this.camera.position.copy(dronePos).add(this._camOffset);

      this._tiltQuat.setFromAxisAngle(this._xAxis, THREE.MathUtils.degToRad(cameraTiltDeg));
      this.camera.quaternion.copy(droneQuat).multiply(this._tiltQuat);
    } else {
      // Third-person chase camera with frame-rate independent exponential damping
      this._forward.set(0, 0, -1).applyQuaternion(droneQuat);
      this._forward.y = 0;
      if (this._forward.lengthSq() < 0.001) {
        this._forward.set(0, 0, -1);
      } else {
        this._forward.normalize();
      }
      this._chaseDesired
        .copy(dronePos)
        .addScaledVector(this._forward, -2.65);
      this._chaseDesired.y += 0.95;

      const minCamY = getTerrainHeight(this._chaseDesired.x, this._chaseDesired.z) + 0.45;
      if (this._chaseDesired.y < minCamY) this._chaseDesired.y = minCamY;

      this.chaseCamPos.x = THREE.MathUtils.damp(this.chaseCamPos.x, this._chaseDesired.x, 7.5, dt);
      this.chaseCamPos.y = THREE.MathUtils.damp(this.chaseCamPos.y, this._chaseDesired.y, 7.5, dt);
      this.chaseCamPos.z = THREE.MathUtils.damp(this.chaseCamPos.z, this._chaseDesired.z, 7.5, dt);

      this.chaseLookAt.x = THREE.MathUtils.damp(this.chaseLookAt.x, dronePos.x, 12, dt);
      this.chaseLookAt.y = THREE.MathUtils.damp(this.chaseLookAt.y, dronePos.y + 0.15, 12, dt);
      this.chaseLookAt.z = THREE.MathUtils.damp(this.chaseLookAt.z, dronePos.z, 12, dt);

      this.camera.position.copy(this.chaseCamPos);
      this.camera.lookAt(this.chaseLookAt);
    }

    // 6. Adaptive Pixel-Ratio Controller (Sustains 60-120 FPS on iPad Air)
    this.fpsAccum += dt;
    this.fpsSamples++;
    if (this.fpsAccum >= 0.5) {
      this.measuredFps = Math.round(this.fpsSamples / this.fpsAccum);
      this.fpsAccum = 0;
      this.fpsSamples = 0;

      if (!this.isSoftwareGl && adaptivePixelRatio) {
        let nextPr = this.currentPixelRatio;
        if (this.measuredFps < 52 && nextPr > 1.0) {
          nextPr = Math.max(1.0, nextPr - 0.15);
        } else if (this.measuredFps >= 58 && nextPr < this.maxPixelRatio) {
          nextPr = Math.min(this.maxPixelRatio, nextPr + 0.1);
        }
        if (Math.abs(nextPr - this.currentPixelRatio) > 0.04) {
          this.currentPixelRatio = Number(nextPr.toFixed(2));
          this.renderer.setPixelRatio(this.currentPixelRatio);
          this.composer?.setPixelRatio(this.currentPixelRatio);
        }
      } else if (!this.isSoftwareGl && !adaptivePixelRatio && this.currentPixelRatio !== this.maxPixelRatio) {
        this.currentPixelRatio = this.maxPixelRatio;
        this.renderer.setPixelRatio(this.currentPixelRatio);
        this.composer?.setPixelRatio(this.currentPixelRatio);
      }
    }

    // 7. Render (Post-Processed FPV Fisheye Pass on GPU when active, Direct Render otherwise)
    const useFisheye = !this.isSoftwareGl && this.composer && this.lensPass && viewMode === 'FPV' && fisheyeStrength > 0.005;
    if (useFisheye) {
      this.lensPass!.uniforms.uDistortion.value = fisheyeStrength;
      this.composer!.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  public getPixelRatio(): number {
    return this.currentPixelRatio;
  }

  public resize(width: number, height: number): void {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    if (this.composer && this.lensPass) {
      this.composer.setSize(w, h);
      this.lensPass.uniforms.uAspect.value = w / h;
    }
  }

  public dispose(): void {
    this.scene.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const m = obj as THREE.Mesh;
        m.geometry?.dispose();
        if (Array.isArray(m.material)) {
          m.material.forEach((mat) => mat.dispose());
        } else {
          m.material?.dispose();
        }
      }
    });
    this.composer?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
