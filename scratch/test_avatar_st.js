import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { getPromptBlendOverlay } from '../src/main/colorUtils.js';

const sampled = { r: 246, g: 186, b: 189 };
const overlay = getPromptBlendOverlay(sampled);
console.log('Sampled:', sampled);
console.log('Overlay:', overlay);
