import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';

// PROVA DE VERSÃO (temporário): se o título da aba do navegador NÃO virar isto assim que a página
// carregar, o navegador está rodando um java.js em cache antigo — nenhuma mudança de código consertará
// nada até isso ser resolvido (Ctrl+Shift+R, ou aba anônima, ou fechar e abrir a aba de novo).
document.title = 'JAVA.JS v15 CARREGADO';

// ===== Configurações do jogador =====
const moveSpeed = 1.5;                   // metros por segundo "equivalentes"; escalado automaticamente para o tamanho real do setup.glb
const REAL_EYE_HEIGHT = 0.55;             // altura real dos olhos de uma pessoa adulta, em metros
const REFERENCE_ROOM_HEIGHT = 2.7;       // altura de teto "de referência" (metros), usada só para descobrir a escala do modelo
let eyeHeight = REAL_EYE_HEIGHT;         // recalculado com base no chão/teto reais do modelo assim que ele carrega
let modelScale = 1;                      // recalculado a partir da altura real do quarto (chão -> teto)
const mouseSensitivity = 0.0015;         // sensibilidade do mouse
const maxPitch = Math.PI / 2 - 0.05;     // limite de olhar para cima/baixo (evita virar de cabeça para baixo)
const REAL_PLAYER_RADIUS = 0.3;          // margem real entre o jogador e as paredes/objetos, em metros
let playerRadius = REAL_PLAYER_RADIUS;   // recalculado para a escala real do modelo assim que ele carrega
const lookSmoothing = 0.2;               // 0 a 1: quanto menor, mais suave o giro da câmera

// Cena
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1117);

// Câmera
const camera = new THREE.PerspectiveCamera(
    70,
    window.innerWidth / window.innerHeight,
    0.01,
    1000
);
camera.rotation.order = 'YXZ';

// Renderer
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap; // sombras suaves
document.body.appendChild(renderer.domElement);

// ===== Tela do computador: renderer CSS3D separado, sobreposto ao WebGL =====
// A "área de trabalho" é DOM real (HTML/CSS/JS) posicionada em 3D com CSS3DObject, usando a
// MESMA câmera do jogo — por isso acompanha exatamente a tela física do monitor. Fica escondida e
// com pointer-events desativados o tempo todo, exceto durante/depois da transição do modo G,
// então nunca interfere no WASD, no mouse-look ou no clique da cadeira (F).
const cssScene = new THREE.Scene();
const cssRenderer = new CSS3DRenderer();
cssRenderer.setSize(window.innerWidth, window.innerHeight);
Object.assign(cssRenderer.domElement.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
    zIndex: '10',
    display: 'none',
});
cssRenderer.domElement.classList.add('css3d-layer');
document.body.appendChild(cssRenderer.domElement);

// Iluminação noturna, elegante e minimalista — sem nenhuma luz colorida/neon, só tons neutros e
// um branco quente suave simulando uma luminária. O ambiente fica escuro o suficiente para
// parecer noite, mas a luz de preenchimento (ambient/hemisphere) evita que algo fique preto puro.
const ambient = new THREE.AmbientLight(0xffffff, 0.4); // levemente mais forte, para as paredes ficarem visíveis
scene.add(ambient);

const hemi = new THREE.HemisphereLight(0x4b5563, 0x0e0e10, 0.55); // gradiente neutro (céu/chão), bem dessaturado
scene.add(hemi);

const keyLight = new THREE.DirectionalLight(0xfff1dd, 1.15); // branco quente suave, tipo luminária
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xffffff, 0.25); // preenchimento neutro (sem tingimento de cor)
fillLight.position.set(-1, 0.6, -1);
scene.add(fillLight);

// ===== Olhar em primeira pessoa (clique e segure o botão esquerdo do mouse) =====
let yaw = 0;
let pitch = 0;
let targetYaw = 0;
let targetPitch = 0;
let pointerLocked = false;

const canvas = renderer.domElement;

canvas.addEventListener('mousedown', (event) => {
    if (isComputerMode) return; // no modo computador o mouse controla a interface, não a câmera
    if (event.button === 0) {
        const result = canvas.requestPointerLock();
        if (result && typeof result.catch === 'function') {
            result.catch(() => {});
        }
    }
});

document.addEventListener('mouseup', (event) => {
    if (event.button === 0 && document.pointerLockElement === canvas) {
        document.exitPointerLock();
    }
});

document.addEventListener('pointerlockchange', () => {
    pointerLocked = document.pointerLockElement === canvas;
});

document.addEventListener('pointerlockerror', () => {
    pointerLocked = false;
});

document.addEventListener('mousemove', (event) => {
    if (!pointerLocked) return;
    targetYaw -= event.movementX * mouseSensitivity;
    targetPitch -= event.movementY * mouseSensitivity;
    targetPitch = Math.max(-maxPitch, Math.min(maxPitch, targetPitch));
});

// ===== Movimento (WASD) =====
const keys = { forward: false, back: false, left: false, right: false };

window.addEventListener('keydown', (event) => setKey(event.code, true));
window.addEventListener('keyup', (event) => setKey(event.code, false));

function setKey(code, value) {
    switch (code) {
        case 'KeyW': keys.forward = value; break;
        case 'KeyS': keys.back = value; break;
        case 'KeyA': keys.left = value; break;
        case 'KeyD': keys.right = value; break;
    }
}

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const raycaster = new THREE.Raycaster();

let collidableMeshes = [];
let roomMaxDim = 10; // atualizado quando o modelo carrega; usado só para alcance dos raios de colisão/chão
let roomBounds = null; // {minX, maxX, minZ, maxZ} calculado a partir do bounding box real do modelo

// Movimento WASD: exatamente como antes, sem nenhum bloqueio aqui. O limite do mapa é aplicado
// depois, em clampToRoom(), sobre a posição resultante — então as teclas nunca são interceptadas.
function updateMovement(delta) {
    let inputForward = 0;
    let inputRight = 0;
    if (keys.forward) inputForward += 1;
    if (keys.back) inputForward -= 1;
    if (keys.right) inputRight += 1;
    if (keys.left) inputRight -= 1;

    if (inputForward === 0 && inputRight === 0) return;

    const len = Math.hypot(inputForward, inputRight);
    inputForward /= len;
    inputRight /= len;

    const distance = moveSpeed * modelScale * delta;

    const forwardDir = new THREE.Vector3(0, 0, -1).applyAxisAngle(UP, yaw);
    const rightDir = new THREE.Vector3(1, 0, 0).applyAxisAngle(UP, yaw);

    const moveF = forwardDir.multiplyScalar(inputForward * distance);
    const moveR = rightDir.multiplyScalar(inputRight * distance);

    camera.position.x += moveF.x + moveR.x;
    camera.position.z += moveF.z + moveR.z;
}

// Limite do mapa: roda DEPOIS do movimento e só reposiciona a câmera de volta para dentro dos
// limites reais do quarto (calculados a partir do bounding box do setup.glb) se ela ultrapassou
// uma parede. Nunca impede o cálculo do movimento nem desativa W/A/S/D — o jogador continua livre
// para andar em qualquer outra direção, inclusive "encostado" numa parede.
function clampToRoom(position) {
    if (!roomBounds) return;
    const margin = playerRadius; // pequena margem para a câmera não ficar dentro da parede
    position.x = THREE.MathUtils.clamp(position.x, roomBounds.minX + margin, roomBounds.maxX - margin);
    position.z = THREE.MathUtils.clamp(position.z, roomBounds.minZ + margin, roomBounds.maxZ - margin);
}

// Acha a altura do chão sob um ponto (x, z). Parte do meio da altura do quarto (y = 0, já que o
// modelo é centralizado no carregamento) em vez de "lá de cima", para nunca acertar o telhado/teto
// por fora e sim o piso interno de verdade.
function findFloorY(x, z) {
    if (collidableMeshes.length === 0) return null;
    raycaster.set(new THREE.Vector3(x, 0, z), DOWN);
    raycaster.far = roomMaxDim;
    const hits = raycaster.intersectObjects(collidableMeshes, true);
    return hits.length > 0 ? hits[0].point.y : null;
}

function updateGrounding() {
    const floorY = findFloorY(camera.position.x, camera.position.z);
    if (floorY !== null) {
        camera.position.y = floorY + eyeHeight;
    }
}

// ===== Interação: sentar na cadeira (F) =====
const promptEl = document.getElementById('sit-prompt');

// Estilo e visibilidade aplicados diretamente via JS (inline), para não depender de nenhuma
// regra do style.css nem de cache do navegador — garante que o aviso apareça de verdade.
if (promptEl) {
    Object.assign(promptEl.style, {
        position: 'fixed',
        left: '50%',
        bottom: '12%',
        transform: 'translateX(-50%)',
        padding: '10px 18px',
        background: 'rgba(0, 0, 0, 0.75)',
        color: '#ffffff',
        fontFamily: 'sans-serif',
        fontSize: '18px',
        fontWeight: '600',
        whiteSpace: 'nowrap',
        borderRadius: '6px',
        pointerEvents: 'none',
        zIndex: '9999',
        display: 'none', // começa escondido; passa a 'block' só quando perto da cadeira
    });
}
console.log('[Cadeira] elemento do aviso encontrado no HTML?', !!promptEl);

const CHAIR_KEYWORDS = ['cadeira', 'chair'];
const FALLBACK_CHAIR_NAME = 'mesh_node'; // melhor estimativa atual (mesma heurística usada para colorir a cadeira)
const REAL_SEATED_EYE_OFFSET = 0.45; // altura aproximada dos olhos acima do assento, sentado, em metros

let chairObject = null;
let chairSeatPosition = null; // posição/altura da câmera quando sentado (calculada da cadeira real)
let chairInteractionRadius = 1; // alcance de interação, proporcional ao tamanho real da cadeira
let isSitting = false;
let nearChair = false;

// Acha o objeto da cadeira pelo nome; usa a mesma estimativa de nome genérico já usada na
// coloração (mesh_node) se não houver um objeto chamado explicitamente "cadeira"/"chair".
function findChairObject(model) {
    let found = null;
    model.traverse((child) => {
        if (found || !child.isMesh) return;
        const nameLower = (child.name || '').toLowerCase();
        if (CHAIR_KEYWORDS.some((k) => nameLower.includes(k))) found = child;
    });
    if (!found) {
        model.traverse((child) => {
            if (!found && child.isMesh && child.name === FALLBACK_CHAIR_NAME) found = child;
        });
    }
    return found;
}

// Calcula a posição/altura de "sentado" e o alcance de interação a partir do tamanho e posição
// reais da cadeira que já existe no modelo — nenhuma cadeira nova é criada.
function setupChairInteraction(model) {
    chairObject = findChairObject(model);
    if (!chairObject) return;

    const chairBox = new THREE.Box3().setFromObject(chairObject);
    const chairCenter = new THREE.Vector3();
    const chairSize = new THREE.Vector3();
    chairBox.getCenter(chairCenter);
    chairBox.getSize(chairSize);

    const seatY = chairBox.min.y + chairSize.y * 0.42; // altura aproximada do assento
    chairSeatPosition = new THREE.Vector3(chairCenter.x, seatY + REAL_SEATED_EYE_OFFSET * modelScale, chairCenter.z);
    chairInteractionRadius = Math.max(chairSize.x, chairSize.z) * 1.5;
}

// Mostra/esconde a mensagem "Pressione F para sentar" conforme a proximidade da cadeira.
let lastChairDebugLog = 0; // diagnóstico temporário: log throttled da distância até a cadeira
function updateChairInteraction() {
    if (!chairObject || isSitting) {
        nearChair = false;
        if (promptEl) promptEl.style.display = 'none';
        return;
    }

    const dx = camera.position.x - chairSeatPosition.x;
    const dz = camera.position.z - chairSeatPosition.z;
    const distance = Math.hypot(dx, dz);
    nearChair = distance <= chairInteractionRadius;

    const now = performance.now();
    if (now - lastChairDebugLog > 1000) {
        console.log('[Cadeira] distância atual:', distance.toFixed(2), '| raio:', chairInteractionRadius.toFixed(2), '| perto?', nearChair);
        lastChairDebugLog = now;
    }

    if (promptEl) promptEl.style.display = nearChair ? 'block' : 'none';
}

function sitDown() {
    camera.position.set(chairSeatPosition.x, chairSeatPosition.y, chairSeatPosition.z);
    isSitting = true;
    if (promptEl) promptEl.style.display = 'none';
}

function standUp() {
    isSitting = false; // updateGrounding() volta a cuidar da altura normalmente no próximo quadro
}

window.addEventListener('keydown', (event) => {
    if (event.code !== 'KeyF' || event.repeat) return;
    // precisa sair do modo computador (G) e a transição de câmera já ter terminado antes de levantar
    if (isComputerMode || computerTransitioning) return;
    if (isSitting) {
        standUp();
    } else if (nearChair) {
        sitDown();
    }
});

// ===== Interação: usar o computador (G), somente enquanto sentado =====
// O node que antes se chamava "Cube.001" no setup8.glb foi renomeado diretamente no arquivo (fora
// do Blender, editando o GLB) para "ComputerScreen" — é a face frontal do monitor, identificada
// geometricamente como a peça mais próxima da cadeira entre as duas que formavam o monitor.
// O monitor agora é localizado EXCLUSIVAMENTE por esse nome, sem heurística de palavra-chave,
// posição ou tamanho.
const MONITOR_SCREEN_NAME = 'ComputerScreen';
const DESKTOP_DOM_WIDTH = 1200; // largura de referência (px) da interface; a altura é derivada da proporção real da tela
const COMPUTER_TRANSITION_DURATION = 1; // segundos, transição suave de zoom até o monitor
const COMPUTER_SCREEN_FILL = 0.72; // fração da altura vertical da câmera que a tela deve preencher no modo computador

// Ajuste ISOLADO só da altura do retângulo ciano de depuração — não afeta screenWidth/screenHeight
// reais (usados pelo desktop, pela câmera ou por qualquer outra coisa). 1 = altura sem alteração;
// >1 = ciano mais alto; <1 = ciano mais baixo.
const DEBUG_CYAN_HEIGHT_SCALE = 1;

let monitorReady = false;
let monitorViewPosition = null;
let monitorViewQuaternion = null;
let desktopEl = null;

// Única fonte de verdade sobre o modo computador: G alterna ESTE booleano (nunca em key repeat).
// computerTransitioning só controla a suavização da câmera entre as duas poses — não decide
// se o modo está ativo, então a tecla nunca fica "presa" nem depende de ficar segurada.
let isComputerMode = false;
let computerTransitioning = false;
let transitionElapsed = 0;
const transitionStartPos = new THREE.Vector3();
const transitionStartQuat = new THREE.Quaternion();
let sittingYawAtEnter = 0;
let sittingPitchAtEnter = 0;

const computerHintEl = document.getElementById('computer-hint');
if (computerHintEl) {
    Object.assign(computerHintEl.style, {
        position: 'fixed',
        left: '50%',
        bottom: '8%',
        transform: 'translateX(-50%)',
        padding: '8px 16px',
        background: 'rgba(0, 0, 0, 0.75)',
        color: '#ffffff',
        fontFamily: 'sans-serif',
        fontSize: '15px',
        fontWeight: '600',
        whiteSpace: 'nowrap',
        borderRadius: '6px',
        pointerEvents: 'none',
        zIndex: '9999',
        display: 'none',
    });
}

function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// Diagnóstico: lista todo mesh do modelo com seu tamanho/centro reais (mundo), para conferir no
// console do navegador exatamente qual objeto é a tela do monitor (nome, forma, posição) sem
// precisar adivinhar.
function logAllMeshes(model) {
    console.log('[Computador] Meshes do setup8.glb (nome | tamanho x,y,z | centro x,y,z):');
    model.traverse((child) => {
        if (!child.isMesh) return;
        const box = new THREE.Box3().setFromObject(child);
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        box.getSize(size);
        box.getCenter(center);
        console.log(
            `  - "${child.name || '(sem nome)'}"`,
            '| tamanho:', `${size.x.toFixed(2)}, ${size.y.toFixed(2)}, ${size.z.toFixed(2)}`,
            '| centro:', `${center.x.toFixed(2)}, ${center.y.toFixed(2)}, ${center.z.toFixed(2)}`
        );
    });
}

// Acha a mesh da TELA do monitor pelo nome EXPLÍCITO "ComputerScreen" — renomeado diretamente no
// setup8.glb (o node que antes se chamava "Cube.001", identificado como a face frontal do monitor,
// mais próxima da cadeira). Sem heurística por palavra-chave, posição ou tamanho: é este objeto,
// ponto. Se não for encontrado, avisa no console em vez de inventar uma posição.
function findMonitorScreenMesh(model) {
    const found = model.getObjectByName(MONITOR_SCREEN_NAME);
    if (!found) {
        console.warn(
            `[Computador] Objeto "${MONITOR_SCREEN_NAME}" não encontrado no setup8.glb.`,
            'Renomeie no Blender a face frontal do monitor para exatamente esse nome e reexporte o GLB.',
            'Veja a lista de meshes acima (logAllMeshes) para conferir os nomes atuais.'
        );
        return null;
    }
    if (!found.isMesh) {
        console.warn(`[Computador] "${MONITOR_SCREEN_NAME}" foi encontrado, mas não é uma mesh (é um ${found.type}).`);
        return null;
    }
    return found;
}

// Monta a interface de desktop (ícones + janelas) como DOM real, para ser embutida na cena via
// CSS3DObject — permite fontes, hover, cliques e CSS normais, sem nenhuma textura/canvas.
function buildDesktopUI() {
    const desktop = document.createElement('div');
    desktop.className = 'desktop';

    const iconsLayer = document.createElement('div');
    iconsLayer.className = 'desktop-icons';
    desktop.appendChild(iconsLayer);

    const windowsLayer = document.createElement('div');
    windowsLayer.className = 'windows-layer';
    desktop.appendChild(windowsLayer);

    const folders = [
        {
            id: 'html',
            label: 'html',
            title: 'html — Pasta de arquivos HTML',
            left: '260px',
            top: '90px',
            files: [
                { icon: '📄', name: 'index.html' },
                { icon: '📄', name: 'sobre.html' },
                { icon: '📄', name: 'contato.html' },
            ],
        },
        {
            id: 'css',
            label: 'css',
            title: 'css — Pasta de arquivos CSS',
            left: '420px',
            top: '190px',
            files: [
                { icon: '🎨', name: 'style.css' },
                { icon: '🎨', name: 'reset.css' },
                { icon: '🎨', name: 'tema.css' },
            ],
        },
    ];

    function openWindow(folder) {
        const already = windowsLayer.querySelector(`[data-folder="${folder.id}"]`);
        if (already) return; // já aberta: não duplica

        const win = document.createElement('div');
        win.className = 'os-window';
        win.dataset.folder = folder.id;
        win.style.left = folder.left;
        win.style.top = folder.top;

        const titlebar = document.createElement('div');
        titlebar.className = 'titlebar';
        const titleSpan = document.createElement('span');
        titleSpan.textContent = folder.title;
        const closeBtn = document.createElement('button');
        closeBtn.className = 'close-btn';
        closeBtn.type = 'button';
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', () => win.remove());
        titlebar.appendChild(titleSpan);
        titlebar.appendChild(closeBtn);

        const body = document.createElement('div');
        body.className = 'body';
        folder.files.forEach((file) => {
            const row = document.createElement('div');
            row.className = 'file-row';
            row.innerHTML = `<span class="file-icon">${file.icon}</span><span>${file.name}</span>`;
            body.appendChild(row);
        });

        win.appendChild(titlebar);
        win.appendChild(body);
        windowsLayer.appendChild(win);
    }

    folders.forEach((folder, index) => {
        const iconEl = document.createElement('div');
        iconEl.className = 'folder-icon';
        iconEl.style.left = '40px';
        iconEl.style.top = (60 + index * 160) + 'px';
        iconEl.innerHTML = `<div class="icon">📁</div><div class="label">${folder.label}</div>`;
        iconEl.addEventListener('click', () => openWindow(folder));
        iconsLayer.appendChild(iconEl);
    });

    return desktop;
}

// Calcula a posição/orientação real da tela do monitor (a partir do bounding box do monitor no
// modelo) e a pose de câmera do modo computador, sem criar nenhum monitor novo nem mover o setup.
function setupMonitorInteraction(model) {
    if (!chairSeatPosition) return;

    logAllMeshes(model);

    const screenMesh = findMonitorScreenMesh(model);
    if (!screenMesh) return; // findMonitorScreenMesh já avisou no console o que fazer
    console.log('[Computador] Mesh escolhido como tela do monitor:', screenMesh.name);

    const monitorBox = new THREE.Box3().setFromObject(screenMesh);

    // DEBUG TEMPORÁRIO — colocado logo aqui, ANTES de qualquer cálculo mais complexo, para que ele
    // apareça mesmo que algo mais adiante na função dê erro. Um contorno sólido magenta bem grosso
    // em volta do mesh escolhido (screenMesh), visível através de outros objetos.
    const debugBoxHelper = new THREE.Box3Helper(monitorBox, 0xff00ff);
    debugBoxHelper.material.depthTest = false;
    debugBoxHelper.renderOrder = 999;
    scene.add(debugBoxHelper);
    console.log('[Computador][DEBUG] Contorno magenta adicionado à cena em volta de:', screenMesh.name, monitorBox);

    const monitorCenter = new THREE.Vector3();
    const monitorSize = new THREE.Vector3();
    monitorBox.getCenter(monitorCenter);
    monitorBox.getSize(monitorSize);

    // Direção horizontal da cadeira até o monitor: usada como a "normal" da tela (a tela olha
    // de volta para quem está sentado).
    const forward = new THREE.Vector3(
        monitorCenter.x - chairSeatPosition.x,
        0,
        monitorCenter.z - chairSeatPosition.z
    );
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();

    // ===== Proporção, tamanho, inclinação e profundidade REAIS da tela (direto da geometria do
    // mesh) — calculado ANTES do screenCenter, porque agora screenCenter usa a profundidade real
    // (localWorldSize[localDepthAxis]) em vez da profundidade aproximada por bounding box alinhado
    // aos eixos do mundo (que ficava inflada pela rotação do objeto e empurrava a tela para fora de
    // mais do que o necessário, ao longo do próprio eixo de profundidade/normal da tela).
    screenMesh.updateWorldMatrix(true, false); // garante que a matriz mundial reflita a posição/rotação atuais
    screenMesh.geometry.computeBoundingBox();
    const localBox = screenMesh.geometry.boundingBox;
    const localSize = new THREE.Vector3();
    localBox.getSize(localSize);

    const worldScale = new THREE.Vector3();
    screenMesh.getWorldScale(worldScale);
    const localWorldSize = {
        x: Math.abs(localSize.x * worldScale.x),
        y: Math.abs(localSize.y * worldScale.y),
        z: Math.abs(localSize.z * worldScale.z),
    };

    const axisNames = ['x', 'y', 'z'];
    const sortedAxes = [...axisNames].sort((a, b) => localWorldSize[a] - localWorldSize[b]);
    const localDepthAxis = sortedAxes[0]; // eixo mais fino da geometria = espessura/normal da tela
    const inPlaneAxes = [sortedAxes[1], sortedAxes[2]]; // os outros dois = largura e altura reais

    const worldQuat = new THREE.Quaternion();
    screenMesh.getWorldQuaternion(worldQuat);

    const axisVectors = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
    const worldAxisDirs = {};
    axisNames.forEach((axis) => {
        worldAxisDirs[axis] = axisVectors[axis].clone().applyQuaternion(worldQuat);
    });

    // Dos dois eixos que formam o plano da tela, o mais alinhado com "para cima" do mundo é a
    // altura; o outro é a largura — assim a proporção sai certa não importa como o mesh foi
    // modelado/rotacionado no Blender.
    const heightAxis = Math.abs(worldAxisDirs[inPlaneAxes[0]].y) >= Math.abs(worldAxisDirs[inPlaneAxes[1]].y)
        ? inPlaneAxes[0]
        : inPlaneAxes[1];
    const widthAxis = inPlaneAxes[0] === heightAxis ? inPlaneAxes[1] : inPlaneAxes[0];

    const screenWidth = localWorldSize[widthAxis];
    const screenHeight = localWorldSize[heightAxis];
    const realDepth = localWorldSize[localDepthAxis]; // profundidade REAL da tela (espessura verdadeira, não inflada pela rotação)

    // Normal real da tela (o eixo mais fino, em direção mundial), forçada a apontar para fora, do
    // lado de quem está sentado — para o eixo +Z do CSS3DObject encarar o jogador.
    const screenPlaneNormal = worldAxisDirs[localDepthAxis].clone().normalize();
    if (screenPlaneNormal.dot(forward) > 0) screenPlaneNormal.negate();

    let screenUp = worldAxisDirs[heightAxis].clone().normalize();
    if (screenUp.dot(UP) < 0) screenUp.negate();

    const screenRight = new THREE.Vector3().crossVectors(screenUp, screenPlaneNormal).normalize();
    screenUp = new THREE.Vector3().crossVectors(screenPlaneNormal, screenRight).normalize();

    const screenQuaternion = new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(screenRight, screenUp, screenPlaneNormal)
    );

    // Face frontal real (mesma referência da linha de depuração): qual lado do eixo de profundidade
    // (min ou max local) fica voltado para a cadeira, e o centro geométrico exato dessa face,
    // transformado pela matriz mundial real do mesh. Usado só para posicionar a TELA/desktop.
    const frontAtMax = worldAxisDirs[localDepthAxis].dot(forward) <= 0;
    const frontDepthLocal = frontAtMax ? localBox.max[localDepthAxis] : localBox.min[localDepthAxis];
    const frontCenterLocal = new THREE.Vector3();
    frontCenterLocal[localDepthAxis] = frontDepthLocal;
    frontCenterLocal[widthAxis] = (localBox.min[widthAxis] + localBox.max[widthAxis]) / 2;
    frontCenterLocal[heightAxis] = (localBox.min[heightAxis] + localBox.max[heightAxis]) / 2;
    const trueFrontCenter = screenMesh.localToWorld(frontCenterLocal.clone());

    // Posição REAL da tela (desktop): centro exato da face frontal + uma pequena folga ao longo da
    // normal real (screenPlaneNormal, já inclui a inclinação) para não ficar encravada na malha.
    // Substitui a fórmula antiga (monitorCenter/monitorBox, com Y aproximado por
    // "min.y + size.y*0.6") — essa fórmula antiga estava ~1.85 unidades deslocada do centro real.
    const screenCenter = trueFrontCenter.clone().addScaledVector(screenPlaneNormal, 0.015 * modelScale);

    // Pose da câmera no modo computador: aproximação PERPENDICULAR à superfície real da tela, ao
    // longo de screenPlaneNormal (a normal real, que já inclui a inclinação do monitor — não mais
    // uma direção horizontal aproximada). A distância vem do FOV real da câmera e da altura REAL da
    // tela (screenHeight), para o desktop preencher boa parte da visão em escala normal (a
    // proporção do desktop não muda — só o quão perto a câmera fica dele).
    const halfFovRad = THREE.MathUtils.degToRad(camera.fov) / 2;
    const idealDistance = screenHeight / (2 * Math.tan(halfFovRad) * COMPUTER_SCREEN_FILL);
    const minDistance = realDepth / 2 + 0.05 * modelScale; // nunca fica dentro da malha do monitor
    const maxDistance = Math.max(minDistance, chairSeatPosition.distanceTo(screenCenter) * 0.95); // nunca passa da cadeira
    const viewDistance = THREE.MathUtils.clamp(idealDistance, minDistance, maxDistance);

    // A câmera fica sobre a normal real da tela (screenPlaneNormal), a viewDistance de distância —
    // uma aproximação perpendicular de verdade, que acompanha a inclinação real do monitor, e não
    // um avanço arbitrário em X/Y/Z do mundo.
    const viewPosition = screenCenter.clone().addScaledVector(screenPlaneNormal, viewDistance);
    const viewLookMatrix = new THREE.Matrix4().lookAt(viewPosition, screenCenter, UP);

    console.log(
        '[Computador] pose calculada | screenCenter:', screenCenter,
        '| screenPlaneNormal:', screenPlaneNormal,
        '| screenWidth/Height:', screenWidth.toFixed(2), screenHeight.toFixed(2),
        '| distância câmera->tela:', viewDistance.toFixed(2),
        '(ideal:', idealDistance.toFixed(2), ', min:', minDistance.toFixed(2), ', max:', maxDistance.toFixed(2), ')',
        '| viewPosition:', viewPosition
    );

    monitorViewPosition = viewPosition;
    monitorViewQuaternion = new THREE.Quaternion().setFromRotationMatrix(viewLookMatrix);

    const domHeight = Math.round(DESKTOP_DOM_WIDTH * (screenHeight / screenWidth));
    desktopEl = buildDesktopUI();
    desktopEl.style.width = DESKTOP_DOM_WIDTH + 'px';
    desktopEl.style.height = domHeight + 'px';

    const cssObject = new CSS3DObject(desktopEl);
    cssObject.position.copy(screenCenter);
    cssObject.quaternion.copy(screenQuaternion);
    const scaleFactor = screenWidth / DESKTOP_DOM_WIDTH;
    cssObject.scale.set(scaleFactor, scaleFactor, 1);
    cssScene.add(cssObject);

    // ===== DEBUG TEMPORÁRIO (remover depois de confirmado visualmente) =====
    // O contorno magenta já foi adicionado mais acima (logo após escolher screenMesh). Aqui:
    //  - retângulo CIANO: NÃO é mais um plano reconstruído a partir de largura/altura/centro/rotação
    //    aproximados — é uma linha (LineLoop) ligando os 4 cantos REAIS da face frontal da geometria
    //    local da ComputerScreen, transformados pela matriz mundial do próprio mesh
    //    (screenMesh.localToWorld). Como os pontos vêm direto da geometria e da transformação real
    //    do objeto (incluindo a inclinação), a linha encosta exatamente na borda por construção —
    //    não depende de nenhum eixo global nem de nenhum valor aproximado.
    //  - esfera VERDE: onde a câmera vai parar no modo computador (monitorViewPosition)
    // frontAtMax/frontDepthLocal já foram calculados mais acima (usados também para screenCenter).
    function localFrontCorner(widthVal, heightVal) {
        const p = new THREE.Vector3();
        p[localDepthAxis] = frontDepthLocal;
        p[widthAxis] = widthVal;
        p[heightAxis] = heightVal;
        return screenMesh.localToWorld(p);
    }

    const cornerPoints = [
        localFrontCorner(localBox.min[widthAxis], localBox.min[heightAxis]),
        localFrontCorner(localBox.max[widthAxis], localBox.min[heightAxis]),
        localFrontCorner(localBox.max[widthAxis], localBox.max[heightAxis]),
        localFrontCorner(localBox.min[widthAxis], localBox.max[heightAxis]),
    ];

    const debugPlane = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(cornerPoints),
        new THREE.LineBasicMaterial({ color: 0x00ffff, depthTest: false })
    );
    scene.add(debugPlane);

    const debugViewMarker = new THREE.Mesh(
        new THREE.SphereGeometry(Math.max(screenWidth, screenHeight) * 0.03, 12, 12),
        new THREE.MeshBasicMaterial({ color: 0x00ff00, depthTest: false })
    );
    debugViewMarker.position.copy(monitorViewPosition ?? viewPosition);
    scene.add(debugViewMarker);
    console.log('[Computador][DEBUG] contorno magenta = mesh escolhido | retângulo ciano = tela calculada | esfera verde = onde a câmera para no modo computador.');

    monitorReady = true;
}

// Inicia (ou reinicia, se o jogador apertar G de novo no meio do caminho) a transição suave da
// câmera para a pose que corresponde ao valor ATUAL de isComputerMode. Sempre parte da posição
// real da câmera nesse instante — nunca de um snapshot antigo — então não existe "respawn": apertar
// G de novo durante a transição simplesmente inverte a câmera suavemente de onde ela já estiver.
function startComputerTransition() {
    transitionStartPos.copy(camera.position);
    transitionStartQuat.copy(camera.quaternion);
    transitionElapsed = 0;
    computerTransitioning = true;

    if (isComputerMode) {
        sittingYawAtEnter = yaw;
        sittingPitchAtEnter = pitch;
        if (pointerLocked) document.exitPointerLock();
        cssRenderer.domElement.style.display = 'block';
        if (computerHintEl) computerHintEl.style.display = 'block';
        if (desktopEl) desktopEl.classList.remove('interactive');
    } else {
        if (desktopEl) desktopEl.classList.remove('interactive');
        if (computerHintEl) computerHintEl.style.display = 'none';
    }
}

// G é estritamente um toggle: só reage ao instante em que a tecla é pressionada (event.repeat
// descarta os eventos repetidos do sistema operacional enquanto ela fica segurada), então segurar
// G não repete nem acumula nenhuma ação.
window.addEventListener('keydown', (event) => {
    if (event.code !== 'KeyG' || event.repeat) return;

    if (!isComputerMode) {
        if (!monitorReady || !isSitting) {
            console.log('[Computador] G ignorado | monitorReady:', monitorReady, '| isSitting:', isSitting);
            return; // só entra sentado e com o monitor identificado
        }
        isComputerMode = true;
    } else {
        isComputerMode = false;
    }
    console.log('[Computador] G pressionado -> isComputerMode:', isComputerMode, '| alvo:', isComputerMode ? monitorViewPosition : chairSeatPosition);
    startComputerTransition();
});

// ===== Paleta visual (quarto noturno, moderno e aconchegante) =====
// O setup6.glb ainda usa materiais genéricos (cinza chapado, sem cor) em todos os objetos, então
// as cores abaixo são aplicadas diretamente aqui, por objeto — sem tocar em geometria/posição.
const ROOM_COLORS = {
    wall: 0xffffff,    // branco
    ceiling: 0xffffff, // branco
    floor: 0xffffff,   // branco
};

const OBJECT_COLORS = {
    wood: 0xffffff,        // branco (mesa/prateleiras)
    chairGray: 0xffffff,   // branco (cadeira)
    matteBlack: 0xffffff,  // branco (monitores, teclado, mouse, headset, partes do PC)
    lightNeutral: 0xffffff, // branco (partes claras dos equipamentos)
};

// Reconhece o objeto pelo nome (funciona automaticamente se você renomear as peças no Blender,
// ex: "Mesa", "Cadeira", "Teclado" — útil para quando o modelo ganhar mais objetos no futuro).
const NAME_KEYWORD_COLORS = [
    [['mesa', 'desk', 'prateleira', 'shelf', 'table'], OBJECT_COLORS.wood, 0.55],
    [['cadeira', 'chair'], OBJECT_COLORS.chairGray, 0.7],
    [['monitor', 'teclado', 'keyboard', 'mouse', 'headset', 'fone', 'gabinete', 'pc'], OBJECT_COLORS.matteBlack, 0.85],
    [['parede', 'wall', 'painel', 'panel'], ROOM_COLORS.wall, 0.9],
];

// O setup6.glb atual só tem nomes genéricos (Cube, mesh_node...), sem identificar as peças.
// Esta é minha melhor estimativa com base no tamanho/posição de cada objeto (ver conversa) —
// ajuste este mapa se eu tiver adivinhado errado qual peça é qual.
const FALLBACK_NAME_COLORS = {
    'Plane': [ROOM_COLORS.wall, 0.9],             // painel/parede extra
    'mesh_node.001': [OBJECT_COLORS.wood, 0.55],  // maior dos dois móveis => mesa
    'mesh_node': [OBJECT_COLORS.chairGray, 0.7],  // menor dos dois móveis => cadeira
    'Cube.001': [OBJECT_COLORS.matteBlack, 0.85], // par de peças pequenas junto à mesa => monitor
    'Cube.002': [OBJECT_COLORS.matteBlack, 0.85],
};

// Colore o "casco" do quarto (paredes+chão+teto na mesma malha) por vértice, usando a direção da
// normal de cada face para saber se é chão, teto ou parede — sem alterar a geometria.
function applyRoomShellColors(mesh) {
    const geometry = mesh.geometry;
    if (!geometry.attributes.normal) geometry.computeVertexNormals();
    const normals = geometry.attributes.normal;
    const count = normals.count;
    const colorArray = new Float32Array(count * 3);

    const ceiling = new THREE.Color(ROOM_COLORS.ceiling);
    const floor = new THREE.Color(ROOM_COLORS.floor);
    const wall = new THREE.Color(ROOM_COLORS.wall);

    // As normais originais do cubo apontam "para fora" (convenção padrão do Blender): a face de
    // baixo (chão) tem normal apontando para -Y, a de cima (teto) para +Y.
    for (let i = 0; i < count; i++) {
        const ny = normals.getY(i);
        const c = ny > 0.5 ? ceiling : ny < -0.5 ? floor : wall;
        colorArray[i * 3] = c.r;
        colorArray[i * 3 + 1] = c.g;
        colorArray[i * 3 + 2] = c.b;
    }

    geometry.setAttribute('color', new THREE.BufferAttribute(colorArray, 3));
    mesh.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
    mesh.castShadow = false;
    mesh.receiveShadow = true;
}

// Aplica a paleta a cada objeto do modelo (chamado depois que ele carrega e é centralizado).
function applyMaterials(model, size) {
    model.traverse((child) => {
        if (!child.isMesh) return;

        const meshBox = new THREE.Box3().setFromObject(child);
        const meshSize = new THREE.Vector3();
        meshBox.getSize(meshSize);

        const isWholeRoomShell = meshSize.x > size.x * 0.85 && meshSize.y > size.y * 0.85 && meshSize.z > size.z * 0.85;
        if (isWholeRoomShell) {
            applyRoomShellColors(child);
            return;
        }

        const nameLower = (child.name || '').toLowerCase();
        let match = null;
        for (const [keywords, color, roughness] of NAME_KEYWORD_COLORS) {
            if (keywords.some((k) => nameLower.includes(k))) {
                match = [color, roughness];
                break;
            }
        }
        if (!match) match = FALLBACK_NAME_COLORS[child.name];
        if (!match) match = [OBJECT_COLORS.matteBlack, 0.8]; // sem info: cor neutra escura por padrão

        const [color, roughness] = match;
        child.material = new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 });
        child.castShadow = true;
        child.receiveShadow = true;
    });
}

// Carregar o modelo do Blender
const loader = new GLTFLoader();

loader.load(
    './setup8.glb',

    (gltf) => {
        const model = gltf.scene;
        scene.add(model);

        const box = new THREE.Box3().setFromObject(model);
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        box.getSize(size);
        box.getCenter(center);

        // Centraliza o modelo na origem: depois disso o chão fica em y = -size.y/2,
        // o teto em y = +size.y/2, e y = 0 é sempre um ponto no MEIO do quarto (nunca acima do telhado).
        model.position.sub(center);

        const roomBox = new THREE.Box3().setFromObject(model);
        const floorY = roomBox.min.y;
        const ceilingY = roomBox.max.y;

        // Descobre a escala real do modelo comparando a altura real do quarto (chão -> teto)
        // com uma altura de teto "de referência" (2,7 m). Isso permite converter medidas reais
        // (altura dos olhos, velocidade) para as unidades do setup.glb, seja qual for a escala usada no Blender.
        const roomHeight = ceilingY - floorY;
        modelScale = roomHeight > 0 ? roomHeight / REFERENCE_ROOM_HEIGHT : 1;
        eyeHeight = REAL_EYE_HEIGHT * modelScale;
        playerRadius = REAL_PLAYER_RADIUS * modelScale;

        const maxDim = Math.max(size.x, size.y, size.z);
        roomMaxDim = maxDim;
        roomBounds = {
            minX: roomBox.min.x,
            maxX: roomBox.max.x,
            minZ: roomBox.min.z,
            maxZ: roomBox.max.z,
        };

        camera.near = Math.max(0.01, maxDim / 1000);
        camera.far = maxDim * 100;
        camera.updateProjectionMatrix();

        // Posiciona a luz principal e ajusta sua câmera de sombra para o tamanho real do quarto
        // (a escala do modelo varia, então esses valores não podem ser fixos).
        keyLight.position.set(maxDim * 0.35, maxDim * 0.55, maxDim * 0.35);
        keyLight.shadow.camera.left = -maxDim * 0.7;
        keyLight.shadow.camera.right = maxDim * 0.7;
        keyLight.shadow.camera.top = maxDim * 0.7;
        keyLight.shadow.camera.bottom = -maxDim * 0.7;
        keyLight.shadow.camera.near = maxDim * 0.05;
        keyLight.shadow.camera.far = maxDim * 2.5;
        keyLight.shadow.normalBias = maxDim * 0.004;
        keyLight.shadow.camera.updateProjectionMatrix();

        // Aplica a paleta de cores do ambiente (paredes/teto/chão/móveis/equipamentos)
        applyMaterials(model, size);

        // Configura a interação de sentar usando a cadeira real do modelo
        setupChairInteraction(model);
        console.log(
            '[Cadeira] objeto encontrado:', chairObject ? chairObject.name : 'NENHUM',
            '| posição/altura de sentar:', chairSeatPosition,
            '| raio de interação:', chairInteractionRadius
        );

        // Configura a tela interativa do computador usando o monitor real do modelo. Em try/catch
        // temporário: se algo dentro dessa função der erro, ele aparece direto no TÍTULO DA ABA do
        // navegador (sem precisar abrir o console) em vez de só travar silenciosamente o modo G.
        try {
            setupMonitorInteraction(model);
            document.title = monitorReady
                ? 'JAVA.JS v15 — monitor OK'
                : 'JAVA.JS v15 — MONITOR NAO ENCONTRADO';
        } catch (erroMonitor) {
            console.error('[Computador] ERRO dentro de setupMonitorInteraction:', erroMonitor);
            document.title = 'ERRO NO MONITOR: ' + erroMonitor.message;
        }
        console.log('[Computador] monitor encontrado?', monitorReady);

        // Meshes do quarto/setup usadas para o jogador "pisar" no chão e para localizar o setup
        collidableMeshes = [];
        const namedBoxes = [];
        const propBoxes = [];
        const setupKeywords = ['setup', 'desk', 'mesa', 'pc', 'computador', 'computer', 'monitor', 'teclado', 'keyboard', 'cadeira', 'chair', 'gamer'];

        model.traverse((child) => {
            if (!child.isMesh) return;
            collidableMeshes.push(child);

            const meshBox = new THREE.Box3().setFromObject(child);

            const meshSize = new THREE.Vector3();
            meshBox.getSize(meshSize);

            // Heurística: paredes/piso/teto cobrem quase toda a extensão do quarto;
            // objetos bem menores que isso são tratados como "o setup".
            const isRoomShell = meshSize.x > size.x * 0.6 || meshSize.z > size.z * 0.6 || meshSize.y > size.y * 0.8;
            const nameLower = (child.name || '').toLowerCase();

            if (setupKeywords.some((k) => nameLower.includes(k))) {
                namedBoxes.push(meshBox);
            } else if (!isRoomShell) {
                propBoxes.push(meshBox);
            }
        });

        // Localiza o setup: usa objetos com nome reconhecível; se não achar, usa os objetos
        // pequenos (não-estruturais); se ainda assim não achar, usa o centro do quarto.
        const candidateBoxes = namedBoxes.length > 0 ? namedBoxes : propBoxes;
        const setupCenter = new THREE.Vector3(0, floorY + eyeHeight, 0);
        if (candidateBoxes.length > 0) {
            const setupBox = candidateBoxes[0].clone();
            for (let i = 1; i < candidateBoxes.length; i++) setupBox.union(candidateBoxes[i]);
            setupBox.getCenter(setupCenter);
        }

        // Ponto de partida: alguns metros afastado do setup, em direção ao centro do quarto
        // (mais chance de ser piso livre do que em direção a uma parede).
        const setupXZ = new THREE.Vector2(setupCenter.x, setupCenter.z);
        const roomCenterXZ = new THREE.Vector2(0, 0);
        const backDir = roomCenterXZ.clone().sub(setupXZ);
        if (backDir.lengthSq() < 1e-6) backDir.set(0, 1);
        backDir.normalize();

        const backDistance = THREE.MathUtils.clamp(Math.min(size.x, size.z) * 0.3, 1.2, 3.5);
        const spawnXZ = setupXZ.clone().addScaledVector(backDir, backDistance);

        const margin = playerRadius + 0.1;
        spawnXZ.x = THREE.MathUtils.clamp(spawnXZ.x, roomBounds.minX + margin, roomBounds.maxX - margin);
        spawnXZ.y = THREE.MathUtils.clamp(spawnXZ.y, roomBounds.minZ + margin, roomBounds.maxZ - margin);

        // Altura: chão real embaixo do ponto de partida (com fallback pro chão do bounding box)
        const spawnFloorY = findFloorY(spawnXZ.x, spawnXZ.y) ?? floorY;
        camera.position.set(spawnXZ.x, spawnFloorY + eyeHeight, spawnXZ.y);
        console.log('[Cadeira] posição inicial da câmera (x,z):', spawnXZ.x, spawnXZ.y);

        // Olha horizontalmente na direção do setup (sem inclinar para cima/baixo)
        const lookDir = new THREE.Vector2(setupCenter.x - spawnXZ.x, setupCenter.z - spawnXZ.y);
        if (lookDir.lengthSq() < 1e-6) lookDir.set(0, -1);
        lookDir.normalize();

        yaw = Math.atan2(-lookDir.x, -lookDir.y);
        targetYaw = yaw;
        pitch = 0;
        targetPitch = 0;
        camera.rotation.set(pitch, yaw, 0);

        console.log('Modelo carregado! Dimensões:', size, '| Chão:', floorY, '| Teto:', ceilingY, '| Setup em:', setupCenter);
    },

    undefined,

    (erro) => {
        console.error('Erro ao carregar o setup:', erro);
    }
);

// Responsividade
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    cssRenderer.setSize(window.innerWidth, window.innerHeight);
});

// Renderização
const clock = new THREE.Clock();

function animate() {
    requestAnimationFrame(animate);

    const delta = clock.getDelta();

    if (computerTransitioning) {
        // Transição cinematográfica: interpola posição e rotação da câmera até a tela do monitor
        // (ou de volta para a pose sentada), sem nunca teletransportar a câmera. Sempre parte de
        // transitionStartPos/Quat, capturados no instante em que G foi pressionado por último —
        // por isso apertar G de novo no meio do caminho apenas reverte suavemente, sem saltos.
        transitionElapsed += delta;
        const t = Math.min(transitionElapsed / COMPUTER_TRANSITION_DURATION, 1);
        const eased = easeInOutCubic(t);

        const destPos = isComputerMode ? monitorViewPosition : chairSeatPosition;
        const destQuat = isComputerMode
            ? monitorViewQuaternion
            : new THREE.Quaternion().setFromEuler(new THREE.Euler(sittingPitchAtEnter, sittingYawAtEnter, 0, 'YXZ'));

        camera.position.lerpVectors(transitionStartPos, destPos, eased);
        camera.quaternion.slerpQuaternions(transitionStartQuat, destQuat, eased);

        if (t >= 1) {
            computerTransitioning = false;
            if (isComputerMode) {
                if (desktopEl) desktopEl.classList.add('interactive');
            } else {
                // Realinha o olhar suavizado com a pose sentada, para não haver nenhum salto ao
                // retomar o controle normal do mouse-look.
                yaw = targetYaw = sittingYawAtEnter;
                pitch = targetPitch = sittingPitchAtEnter;
                cssRenderer.domElement.style.display = 'none';
            }
        }
    } else if (!isComputerMode) {
        // Suaviza o giro da câmera ao olhar (exatamente como antes de existir o modo computador)
        yaw += (targetYaw - yaw) * lookSmoothing;
        pitch += (targetPitch - pitch) * lookSmoothing;
        camera.rotation.set(pitch, yaw, 0);
    }
    // isComputerMode && !computerTransitioning: câmera permanece fixa exatamente na pose do monitor.

    if (!isSitting) {
        updateMovement(delta);
        clampToRoom(camera.position);
        updateGrounding();
    }
    updateChairInteraction();

    renderer.render(scene, camera);
    cssRenderer.render(cssScene, camera);
}

animate();
