import { getPromptBlendOverlay } from '../src/main/colorUtils.js';

const sampled = { r: 246, g: 186, b: 189 };
const overlay = getPromptBlendOverlay(sampled);
console.log('Sampled:', JSON.stringify(sampled));
console.log('Overlay:', JSON.stringify(overlay));
