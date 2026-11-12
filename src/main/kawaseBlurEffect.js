import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';
import { getKawaseConfiguration, getKawaseInputBounds } from './kawaseSampling.js';

export { getKawaseConfiguration, getKawaseInputBounds };

let _box = null;
let _color = null;

function addRectangle(node, x, y, width, height) {
    if (!_box)
        _box = new Clutter.ActorBox();
    _box.init(x, y, x + width, y + height);
    node.add_rectangle(_box);
}

function setPaintOpacity(pipeline, opacity) {
    if (!_color)
        _color = new Cogl.Color();
    _color.init_from_4f(opacity, opacity, opacity, opacity);
    pipeline.set_color(_color);
}

const REGION_COMPONENTS = ['scale_x', 'scale_y', 'max_x', 'max_y'];
const SOURCE_REGION = 'wack_source_region';
const ORIGINAL_REGION = 'wack_original_region';
const MASK_REGION = 'wack_mask_region';

function textureRegionDeclarations(name) {
    const uniforms = REGION_COMPONENTS
        .map(comp => `uniform float ${name}_${comp};`)
        .join('\n');
    const components = REGION_COMPONENTS
        .map(comp => `${name}_${comp}`)
        .join(', ');
    return `${uniforms}\n#define ${name} vec4(${components})\n`;
}

const TEXTURE_REGION_SOURCE = `
vec4 wack_sample_region(sampler2D source, vec2 uv, vec4 region) {
    return texture2D(source, min(uv, region.zw));
}
`;

const SOURCE_SAMPLING_DECLARATIONS = `
${textureRegionDeclarations(SOURCE_REGION)}
${TEXTURE_REGION_SOURCE}
#define source_sample(uv) wack_sample_region(cogl_sampler0, uv, ${SOURCE_REGION})
`;

const ORIGINAL_SAMPLING_DECLARATIONS = `
${textureRegionDeclarations(ORIGINAL_REGION)}
#define original_sample() wack_sample_region(cogl_sampler1, cogl_tex_coord1_in.xy * ${ORIGINAL_REGION}.xy, ${ORIGINAL_REGION})
`;

const MASK_SAMPLING_DECLARATIONS = `
${textureRegionDeclarations(MASK_REGION)}
#define mask_sample(uv) wack_sample_region(cogl_sampler2, (uv) * ${MASK_REGION}.xy, ${MASK_REGION})
`;

const DOWNSAMPLE_DECLARATIONS = `
uniform float halfpixel_x;
uniform float halfpixel_y;
#define halfpixel vec2(halfpixel_x, halfpixel_y)
${SOURCE_SAMPLING_DECLARATIONS}
`;

const DOWNSAMPLE_CODE = `
vec2 uv = cogl_tex_coord_in[0].xy * ${SOURCE_REGION}.xy;
vec4 sum = source_sample(uv) * 4.0;
sum += source_sample(uv - halfpixel * 2.0);
sum += source_sample(uv + halfpixel * 2.0);
sum += source_sample(uv + vec2(halfpixel.x, -halfpixel.y) * 2.0);
sum += source_sample(uv - vec2(halfpixel.x, -halfpixel.y) * 2.0);
cogl_color_out = sum / 8.0;
`;

const UPSAMPLE_DECLARATIONS = `
uniform float halfpixel_x;
uniform float halfpixel_y;
#define halfpixel vec2(halfpixel_x, halfpixel_y)
uniform float level_blend;
${SOURCE_SAMPLING_DECLARATIONS}
${ORIGINAL_SAMPLING_DECLARATIONS}
`;

const UPSAMPLE_BODY = `
vec2 uv = cogl_tex_coord_in[0].xy * ${SOURCE_REGION}.xy;
vec4 sum = source_sample(uv - halfpixel);
sum += source_sample(uv + halfpixel);
sum += source_sample(uv + vec2(halfpixel.x, -halfpixel.y));
sum += source_sample(uv - vec2(halfpixel.x, -halfpixel.y));
vec4 color = sum / 4.0;
`;

const UPSAMPLE_CODE = `${UPSAMPLE_BODY}
if (level_blend < 1.0)
    color = mix(original_sample(), color, level_blend);
cogl_color_out = color;
`;

const ANTIALIASING_SOURCE = `
float wack_antialias_width(float distance) {
    return max(fwidth(distance), 0.0001);
}
`;

const UPSAMPLE_OUTPUT_DECLARATIONS = `${UPSAMPLE_DECLARATIONS}
uniform float opacity_factor;
uniform float brightness;
uniform float corner_radius;
uniform float output_width;
uniform float output_height;
uniform float mask_x;
uniform float mask_y;
uniform float mask_width;
uniform float mask_height;
${ANTIALIASING_SOURCE}
uniform float wack_resource_scale;

float dither(vec2 position) {
    return fract(52.9829189 * fract(dot(position, vec2(0.06711056, 0.00583715)))) - 0.5;
}

float corner_coverage(vec2 position) {
    vec2 size = max(vec2(mask_width, mask_height), vec2(1.0));
    vec2 point = position - vec2(mask_x, mask_y) - size * 0.5;
    float radius = corner_radius;
    vec2 q = abs(point) - size * 0.5 + vec2(radius);
    float distance = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - radius;
    float antialias_width = wack_antialias_width(distance);
    return 1.0 - smoothstep(-antialias_width * 0.5, antialias_width * 0.5, distance);
}
`;

const UPSAMPLE_OUTPUT_CODE = `
vec4 sourceColor = original_sample();
vec4 filteredColor = sourceColor;
if (level_blend > 0.0) {
    vec4 color = source_sample(cogl_tex_coord_in[0].xy * ${SOURCE_REGION}.xy);
    filteredColor = mix(sourceColor, color, level_blend);
}
filteredColor.rgb *= brightness;
cogl_color_out = mix(sourceColor, filteredColor, opacity_factor) * cogl_color_in.a;
vec2 position = cogl_tex_coord_in[0].xy * vec2(output_width, output_height);
cogl_color_out.rgb += dither(position * wack_resource_scale) * 2.0 / 255.0 * cogl_color_out.a;
if (corner_radius > 0.0)
    cogl_color_out *= corner_coverage(position);
`;

const GLYPH_OUTPUT_DECLARATIONS = `${UPSAMPLE_DECLARATIONS}
${MASK_SAMPLING_DECLARATIONS}
uniform float opacity_factor;
uniform float brightness;
uniform float output_width;
uniform float output_height;
uniform float tint_r;
uniform float tint_g;
uniform float tint_b;
#define clock_tint vec3(tint_r, tint_g, tint_b)
uniform float clock_tint_alpha;
uniform float text_alpha;
uniform float wack_resource_scale;

float dither(vec2 position) {
    return fract(52.9829189 * fract(dot(position, vec2(0.06711056, 0.00583715)))) - 0.5;
}
`;

const GLYPH_OUTPUT_CODE = `
vec4 sourceColor = original_sample();
vec4 filteredColor = sourceColor;
if (level_blend > 0.0) {
    vec4 color = source_sample(cogl_tex_coord_in[0].xy * ${SOURCE_REGION}.xy);
    filteredColor = mix(sourceColor, color, level_blend);
}
filteredColor.rgb *= brightness;
vec4 blurredColor = mix(sourceColor, filteredColor, opacity_factor);
vec2 position = cogl_tex_coord_in[0].xy * vec2(output_width, output_height);
blurredColor.rgb += dither(position * wack_resource_scale) * 2.0 / 255.0 * blurredColor.a;

// Mix blurred background with clock tint
blurredColor.rgb = mix(blurredColor.rgb, clock_tint, clock_tint_alpha);

// Sample mask from text glyph texture
vec4 mask = mask_sample(cogl_tex_coord_in[0].xy);
float glyphAlpha = clamp(mask.a / max(text_alpha, 0.01), 0.0, 1.0);

// Mask output by glyph alpha, correctly premultiplied
cogl_color_out = blurredColor * (glyphAlpha * opacity_factor * cogl_color_in.a);
`;

const snippets = new Map();
function getSnippet(key, create) {
    let snippet = snippets.get(key);
    if (!snippet) {
        snippet = create();
        snippets.set(key, snippet);
    }
    return snippet;
}

function createSnippet(declarations, code) {
    return getSnippet(`${declarations}\n${code}`, () => {
        const snippet = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, declarations, null);
        snippet.set_replace(code);
        return snippet;
    });
}

function levelSize(size, level) {
    return Math.max(1, Math.ceil(size / 2 ** level));
}

function resizeRenderTarget(target, level, width, height) {
    target.usedWidth = levelSize(width, level);
    target.usedHeight = levelSize(height, level);
    target.framebuffer.set_viewport(0, 0, target.usedWidth, target.usedHeight);
}

function projectRenderTarget(target, bounds) {
    target.framebuffer.orthographic(bounds.x, bounds.y,
        bounds.x + bounds.width, bounds.y + bounds.height, -1, 1);
}

function createRenderTarget(context, width, height) {
    const texture = Cogl.Texture2D.new_with_size(context, width, height);
    texture.set_components(Cogl.TextureComponents.RGBA);
    texture.allocate();

    const framebuffer = Cogl.Offscreen.new_with_texture(texture);
    framebuffer.allocate();

    const layerPipeline = Cogl.Pipeline.new(context);
    layerPipeline.set_layer_texture(0, texture);
    setPaintOpacity(layerPipeline, 0);

    return { texture, framebuffer, layerPipeline, width, height, usedWidth: 0, usedHeight: 0 };
}

function createPassPipeline(context, texture, declarations, code) {
    const pipeline = Cogl.Pipeline.new(context);
    pipeline.set_layer_texture(0, texture);
    pipeline.set_layer_filters(0, Cogl.PipelineFilter.LINEAR, Cogl.PipelineFilter.LINEAR);
    pipeline.set_layer_wrap_mode(0, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
    pipeline.add_snippet(createSnippet(declarations, code));
    return pipeline;
}

function setFloat(pipeline, name, value) {
    pipeline.set_uniform_1f(pipeline.get_uniform_location(name), value);
}

function setVector2(pipeline, name, x, y) {
    setFloat(pipeline, `${name}_x`, x);
    setFloat(pipeline, `${name}_y`, y);
}

function captureGeometry(actor, framebuffer) {
    const scale = actor.get_resource_scale();
    const mv = framebuffer?.get_modelview_matrix ? framebuffer.get_modelview_matrix() : null;
    const proj = framebuffer?.get_projection_matrix ? framebuffer.get_projection_matrix() : null;
    if (!mv || !proj) {
        const [originX, originY] = actor.get_transformed_position();
        return { sourceX: Math.round(originX * scale), sourceY: Math.round(originY * scale) };
    }

    const m = mv.multiply(proj).to_float();
    const viewportX = framebuffer.get_viewport_x ? framebuffer.get_viewport_x() : 0;
    const viewportY = framebuffer.get_viewport_y ? framebuffer.get_viewport_y() : 0;
    const viewportWidth = framebuffer.get_viewport_width ? framebuffer.get_viewport_width() : framebuffer.get_width();
    const viewportHeight = framebuffer.get_viewport_height ? framebuffer.get_viewport_height() : framebuffer.get_height();

    const corners = [[0, 0], [actor.width, 0], [0, actor.height], [actor.width, actor.height]]
        .map(([x, y]) => {
            const w = x * m[3] + y * m[7] + m[15];
            if (Math.abs(w) < 0.0001)
                return [viewportX, viewportY];
            return [
                viewportX + ((x * m[0] + y * m[4] + m[12]) / w + 1) * viewportWidth / 2,
                viewportY + (1 - (x * m[1] + y * m[5] + m[13]) / w) * viewportHeight / 2,
            ];
        });

    const xs = corners.map(p => p[0]);
    const ys = corners.map(p => p[1]);
    return {
        sourceX: Math.floor(Math.min(...xs)),
        sourceY: Math.floor(Math.min(...ys)),
    };
}

function addPassNode(parent, target, pipeline, bounds, name) {
    const layerNode = Clutter.LayerNode.new_to_framebuffer(
        target.framebuffer,
        target.layerPipeline
    );
    layerNode.set_name(name);
    parent.add_child(layerNode);

    const pipelineNode = new Clutter.PipelineNode(pipeline);
    pipelineNode.set_name(`${name} sample`);
    addRectangle(pipelineNode, bounds.x, bounds.y, bounds.width, bounds.height);
    layerNode.add_child(pipelineNode);
}

class TextureRegion {
    constructor(pipeline, name) {
        this.pipeline = pipeline;
        this.locations = REGION_COMPONENTS.map(comp =>
            pipeline.get_uniform_location(`${name}_${comp}`));
    }

    update({ usedWidth, usedHeight, width, height }) {
        const [scaleX, scaleY, maxX, maxY] = this.locations;
        this.pipeline.set_uniform_1f(scaleX, usedWidth / width);
        this.pipeline.set_uniform_1f(scaleY, usedHeight / height);
        this.pipeline.set_uniform_1f(maxX, (usedWidth - 0.5) / width);
        this.pipeline.set_uniform_1f(maxY, (usedHeight - 0.5) / height);
    }
}

export const KawaseBlurEffect = GObject.registerClass({
    GTypeName: 'WackKawaseBlurEffect',
    Properties: {
        'radius': GObject.ParamSpec.double(
            'radius', null, null,
            GObject.ParamFlags.READWRITE,
            0, 200, 30
        ),
        'brightness': GObject.ParamSpec.double(
            'brightness', null, null,
            GObject.ParamFlags.READWRITE,
            0, 1, 0.6
        ),
        'opacity-factor': GObject.ParamSpec.double(
            'opacity-factor', null, null,
            GObject.ParamFlags.READWRITE,
            0, 1, 1.0
        ),
        'corner-radius': GObject.ParamSpec.double(
            'corner-radius', null, null,
            GObject.ParamFlags.READWRITE,
            0, Number.MAX_SAFE_INTEGER, 0
        ),
        'mode': GObject.ParamSpec.int(
            'mode', null, null,
            GObject.ParamFlags.READWRITE,
            0, 2, 0
        ),
        'live': GObject.ParamSpec.boolean(
            'live', null, null,
            GObject.ParamFlags.READWRITE,
            false
        ),
        'tint-r': GObject.ParamSpec.double(
            'tint-r', null, null,
            GObject.ParamFlags.READWRITE,
            0, 1, 1.0
        ),
        'tint-g': GObject.ParamSpec.double(
            'tint-g', null, null,
            GObject.ParamFlags.READWRITE,
            0, 1, 1.0
        ),
        'tint-b': GObject.ParamSpec.double(
            'tint-b', null, null,
            GObject.ParamFlags.READWRITE,
            0, 1, 1.0
        ),
        'tint-alpha': GObject.ParamSpec.double(
            'tint-alpha', null, null,
            GObject.ParamFlags.READWRITE,
            0, 1, 0.4
        ),
    },
}, class KawaseBlurEffect extends Clutter.Effect {
    _init(params = {}) {
        super._init();
        this.downTargets = [];
        this.upTargets = [];
        this.downPipelines = [];
        this.upPipelines = [];
        this.outputPipeline = null;
        this.maskTarget = null;
        this.regions = new Map();
        this.width = 0;
        this.height = 0;
        this.logicalWidth = 0;
        this.logicalHeight = 0;
        this.x = 0;
        this.y = 0;
        this.capacityWidth = 0;
        this.capacityHeight = 0;
        this.context = null;
        this.appliedSampling = null;
        this.blurValid = false;
        this.appliedOutputUniforms = null;
        this._lastX = null;
        this._lastY = null;
        this._lastW = null;
        this._lastH = null;

        this._radius = params.radius ?? 30;
        this._brightness = params.brightness ?? 0.6;
        this._opacity_factor = params.opacity_factor ?? 1.0;
        this._corner_radius = params.corner_radius ?? 0;
        this._mode = params.mode ?? 0;
        this._live = params.live ?? false;
        this._tint_r = params.tint_r ?? 1.0;
        this._tint_g = params.tint_g ?? 1.0;
        this._tint_b = params.tint_b ?? 1.0;
        this._tint_alpha = params.tint_alpha ?? 0.4;
    }

    get tint_r() { return this._tint_r; }
    set tint_r(val) {
        const clamped = Math.max(0, Math.min(1, val));
        if (this._tint_r === clamped) return;
        this._tint_r = clamped;
        this.appliedOutputUniforms = null;
        this.queue_repaint();
        this.notify('tint-r');
    }

    get tint_g() { return this._tint_g; }
    set tint_g(val) {
        const clamped = Math.max(0, Math.min(1, val));
        if (this._tint_g === clamped) return;
        this._tint_g = clamped;
        this.appliedOutputUniforms = null;
        this.queue_repaint();
        this.notify('tint-g');
    }

    get tint_b() { return this._tint_b; }
    set tint_b(val) {
        const clamped = Math.max(0, Math.min(1, val));
        if (this._tint_b === clamped) return;
        this._tint_b = clamped;
        this.appliedOutputUniforms = null;
        this.queue_repaint();
        this.notify('tint-b');
    }

    get tint_alpha() { return this._tint_alpha; }
    set tint_alpha(val) {
        const clamped = Math.max(0, Math.min(1, val));
        if (this._tint_alpha === clamped) return;
        this._tint_alpha = clamped;
        this.appliedOutputUniforms = null;
        this.queue_repaint();
        this.notify('tint-alpha');
    }

    get live() { return this._live; }
    set live(val) {
        const boolVal = Boolean(val);
        if (this._live === boolVal) return;
        this._live = boolVal;
        this.blurValid = false;
        this.queue_repaint();
        this.notify('live');
    }

    get mode() { return this._mode; }
    set mode(val) {
        if (this._mode === val) return;
        this._mode = val;
        this.blurValid = false;
        this.queue_repaint();
        this.notify('mode');
    }

    get radius() { return this._radius; }
    set radius(val) {
        const clamped = Math.max(0, Math.min(200, val));
        if (this._radius === clamped) return;
        this._radius = clamped;
        this.blurValid = false;
        this.queue_repaint();
        this.notify('radius');
    }

    get brightness() { return this._brightness; }
    set brightness(val) {
        const clamped = Math.max(0, Math.min(1, val));
        if (this._brightness === clamped) return;
        this._brightness = clamped;
        if (this.outputPipeline)
            setFloat(this.outputPipeline, 'brightness', clamped);
        this.queue_repaint();
        this.notify('brightness');
    }

    get opacity_factor() { return this._opacity_factor; }
    set opacity_factor(val) {
        const clamped = Math.max(0, Math.min(1, val));
        if (this._opacity_factor === clamped) return;
        this._opacity_factor = clamped;
        if (this.outputPipeline)
            setFloat(this.outputPipeline, 'opacity_factor', clamped);
        this.queue_repaint();
        this.notify('opacity-factor');
    }

    get corner_radius() { return this._corner_radius; }
    set corner_radius(val) {
        const clamped = Math.max(0, val);
        if (this._corner_radius === clamped) return;
        this._corner_radius = clamped;
        this.queue_repaint();
        this.notify('corner-radius');
    }

    set(params = {}) {
        for (const [key, value] of Object.entries(params)) {
            if (key in this)
                this[key] = value;
            else if (key === 'corner_radius' || key === 'corner-radius')
                this.corner_radius = value;
            else if (key === 'opacity_factor' || key === 'opacity-factor')
                this.opacity_factor = value;
            else if (key === 'tint_r' || key === 'tint-r')
                this.tint_r = value;
            else if (key === 'tint_g' || key === 'tint-g')
                this.tint_g = value;
            else if (key === 'tint_b' || key === 'tint-b')
                this.tint_b = value;
            else if (key === 'tint_alpha' || key === 'tint-alpha')
                this.tint_alpha = value;
        }
    }

    updateOutputUniforms(actor, outputBounds) {
        const surface = { x: 0, y: 0, width: actor.width, height: actor.height };
        const resourceScale = actor.get_resource_scale();
        const themeScale = St.ThemeContext.get_for_stage(actor.get_stage()).scale_factor;
        const radius = this._corner_radius > 0
            ? Math.min(this._corner_radius * themeScale, surface.width / 2, surface.height / 2)
            : 0;

        const uniforms = [
            radius, outputBounds.width, outputBounds.height, outputBounds.x, outputBounds.y,
            surface.x - outputBounds.x, surface.y - outputBounds.y, surface.width, surface.height,
            resourceScale,
            this._tint_r, this._tint_g, this._tint_b, this._tint_alpha,
        ];
        if (this.appliedOutputUniforms?.every((v, i) => v === uniforms[i]))
            return;

        const pipeline = this.outputPipeline;
        setFloat(pipeline, 'corner_radius', radius);
        setFloat(pipeline, 'output_width', outputBounds.width);
        setFloat(pipeline, 'output_height', outputBounds.height);
        setFloat(pipeline, 'mask_x', surface.x - outputBounds.x);
        setFloat(pipeline, 'mask_y', surface.y - outputBounds.y);
        setFloat(pipeline, 'mask_width', surface.width);
        setFloat(pipeline, 'mask_height', surface.height);
        setFloat(pipeline, 'wack_resource_scale', resourceScale);
        if (this._mode === 2) {
            setFloat(pipeline, 'tint_r', this._tint_r);
            setFloat(pipeline, 'tint_g', this._tint_g);
            setFloat(pipeline, 'tint_b', this._tint_b);
            setFloat(pipeline, 'clock_tint_alpha', this._tint_alpha);
        }
        this.appliedOutputUniforms = uniforms;
    }

    ensureTargets(context, bounds, scale, passes) {
        const { x, y, width: logicalWidth, height: logicalHeight } = bounds;
        const width = Math.max(1, Math.ceil(logicalWidth * scale));
        const height = Math.max(1, Math.ceil(logicalHeight * scale));

        if (this.context !== context || width > this.capacityWidth || height > this.capacityHeight) {
            this.releaseTargets();
            this.capacityWidth = Math.ceil(width * 1.25);
            this.capacityHeight = Math.ceil(height * 1.25);
            this.context = context;
        }

        const targetCount = this.downTargets.length;
        for (let level = this.downTargets.length; level <= passes; level++) {
            this.downTargets.push(createRenderTarget(
                context,
                levelSize(this.capacityWidth, level),
                levelSize(this.capacityHeight, level)
            ));
        }

        for (let level = Math.max(1, this.downPipelines.length); level <= passes; level++) {
            this.downPipelines[level] = this.createPass(
                this.downTargets[level - 1],
                context,
                DOWNSAMPLE_DECLARATIONS,
                DOWNSAMPLE_CODE
            );
        }

        for (let level = Math.max(1, this.upTargets.length); level < passes; level++) {
            this.upTargets[level] = createRenderTarget(
                context,
                levelSize(this.capacityWidth, level),
                levelSize(this.capacityHeight, level)
            );
            this.upPipelines[level] = this.createPass(
                this.downTargets[level + 1],
                context,
                UPSAMPLE_DECLARATIONS,
                UPSAMPLE_CODE,
                this.downTargets[level]
            );
        }

        if (!this.outputPipeline) {
            this.outputPipeline = this.createPass(
                this.downTargets[1], context,
                UPSAMPLE_OUTPUT_DECLARATIONS, UPSAMPLE_OUTPUT_CODE,
                this.downTargets[0], true
            );
        }

        const resized = targetCount !== this.downTargets.length
            || this.width !== width || this.height !== height;
        if (!resized && this.logicalWidth === logicalWidth && this.logicalHeight === logicalHeight
            && this.x === x && this.y === y)
            return;

        this.blurValid = false;

        if (resized) {
            this.downTargets.forEach((target, level) =>
                resizeRenderTarget(target, level, width, height));
            this.upTargets.forEach((target, level) =>
                resizeRenderTarget(target, level, width, height));
            if (this.maskTarget)
                resizeRenderTarget(this.maskTarget, 0, width, height);
            this.updateRegions();
        }
        this.downTargets.forEach(target => projectRenderTarget(target, bounds));
        this.upTargets.forEach(target => projectRenderTarget(target, bounds));
        if (this.maskTarget)
            projectRenderTarget(this.maskTarget, bounds);
        this.width = width;
        this.height = height;
        this.logicalWidth = logicalWidth;
        this.logicalHeight = logicalHeight;
        this.x = x;
        this.y = y;
    }

    updateRegions() {
        this.downPipelines.forEach((pipeline, level) =>
            this.regions.get(pipeline).source.update(this.downTargets[level - 1]));
        this.upPipelines.forEach((pipeline, level) => {
            const regs = this.regions.get(pipeline);
            regs.source.update(this.downTargets[level + 1]);
            regs.original.update(this.downTargets[level]);
        });
        const outputRegions = this.regions.get(this.outputPipeline);
        if (outputRegions) {
            outputRegions.source.update(this.downTargets[1]);
            outputRegions.original.update(this.downTargets[0]);
            if (outputRegions.mask && this.maskTarget)
                outputRegions.mask.update(this.maskTarget);
        }
    }

    createPass(source, context, declarations, code, original = null, outputPass = false, mask = null) {
        const pipeline = createPassPipeline(context, source.texture, declarations, code);
        this.regions.set(pipeline, {
            source: new TextureRegion(pipeline, SOURCE_REGION),
            original: original ? new TextureRegion(pipeline, ORIGINAL_REGION) : null,
            mask: mask ? new TextureRegion(pipeline, MASK_REGION) : null,
        });
        setVector2(pipeline, 'halfpixel', 0.5 / source.width, 0.5 / source.height);
        if (original) {
            pipeline.set_layer_texture(1, original.texture);
            pipeline.set_layer_filters(1, Cogl.PipelineFilter.LINEAR, Cogl.PipelineFilter.LINEAR);
            pipeline.set_layer_wrap_mode(1, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
            setFloat(pipeline, 'level_blend', 1);
        }
        if (mask) {
            pipeline.set_layer_texture(2, mask.texture);
            pipeline.set_layer_filters(2, Cogl.PipelineFilter.LINEAR, Cogl.PipelineFilter.LINEAR);
            pipeline.set_layer_wrap_mode(2, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
        }
        if (outputPass) {
            setFloat(pipeline, 'brightness', this._brightness);
            setFloat(pipeline, 'opacity_factor', this._opacity_factor);
        }
        return pipeline;
    }

    configureUpsample(pipeline, level, passes, blend) {
        const source = level === passes - 1
            ? this.downTargets[level + 1] : this.upTargets[level + 1];
        pipeline.set_layer_texture(0, source.texture);
        setFloat(pipeline, 'level_blend', level === passes - 1 ? blend : 1);
    }

    updateSampling(passes, blend) {
        if (this.appliedSampling?.passes === passes
            && this.appliedSampling.blend === blend)
            return;

        for (let level = passes - 1; level >= 1; level--)
            this.configureUpsample(this.upPipelines[level], level, passes, blend);
        this.configureUpsample(this.outputPipeline, 0, passes, blend);
        this.appliedSampling = { passes, blend };
        this.blurValid = false;
    }

    invalidate() {
        this.blurValid = false;
        this._lastX = null;
        this._lastY = null;
        this._lastW = null;
        this._lastH = null;
        this.queue_repaint();
    }

    vfunc_paint_node(node, paintContext, flags) {
        const actor = this.get_actor();
        if (!actor || actor.width <= 0 || actor.height <= 0)
            return;

        const paintOpacity = actor.get_paint_opacity();
        if (paintOpacity === 0)
            return;

        if (this._radius === 0 || this._opacity_factor === 0) {
            node.add_child(new Clutter.ActorNode(actor, -1));
            this.blurValid = false;
            return;
        }

        const framebuffer = paintContext?.get_framebuffer ? paintContext.get_framebuffer() : null;
        const context = framebuffer ? framebuffer.get_context() : this.context;
        if (!context) {
            node.add_child(new Clutter.ActorNode(actor, -1));
            return;
        }

        const scale = actor.get_resource_scale();
        const themeScale = St.ThemeContext.get_for_stage(actor.get_stage()).scale_factor;
        const { passes, blend } = getKawaseConfiguration(this._radius * themeScale * scale);

        const bounds = { x: 0, y: 0, width: actor.width, height: actor.height };
        const inputBounds = getKawaseInputBounds(bounds, actor.width, actor.height, scale, passes);
        if (inputBounds.width <= 0 || inputBounds.height <= 0)
            return;

        this.ensureTargets(context, inputBounds, scale, passes);
        this.updateSampling(passes, blend);

        const [originX, originY] = actor.get_transformed_position();
        const [w, h] = actor.get_transformed_size();
        const stageView = paintContext?.get_stage_view ? paintContext.get_stage_view() : null;
        let viewX = Math.round(originX);
        let viewY = Math.round(originY);
        if (stageView) {
            // get_layout() requires an MtkRectangle* in-param in Mutter 18+.
            // Access the GObject property directly instead.
            const layout = stageView.layout;
            viewX -= layout.x;
            viewY -= layout.y;
        }

        const isActorDirty = Boolean(flags & Clutter.EffectPaintFlags.ACTOR_DIRTY);
        const positionChanged = (this._lastX !== viewX || this._lastY !== viewY ||
            this._lastW !== w || this._lastH !== h);

        const needsCapture = this._live
            || (this._mode === 1 ? (!this.blurValid || positionChanged) : (!this.blurValid || isActorDirty || positionChanged));

        if (needsCapture) {
            this.addBlurPasses(node, actor, inputBounds, passes, blend, paintContext);
            this.blurValid = true;
            this._lastX = viewX;
            this._lastY = viewY;
            this._lastW = w;
            this._lastH = h;
        }

        this.updateOutputUniforms(actor, inputBounds);
        setPaintOpacity(this.outputPipeline, paintOpacity / 255);
        const outputNode = new Clutter.PipelineNode(this.outputPipeline);
        outputNode.set_name('WackKawase output');
        addRectangle(outputNode, inputBounds.x, inputBounds.y, inputBounds.width, inputBounds.height);
        node.add_child(outputNode);

        if (this._mode === 1) {
            node.add_child(new Clutter.ActorNode(actor, -1));
        }
    }

    addBlurPasses(node, actor, bounds, passes, blend, paintContext) {
        const sourceFramebuffer = paintContext?.get_framebuffer ? paintContext.get_framebuffer() : null;
        if (this._mode === 1 && sourceFramebuffer) {
            const geom = captureGeometry(actor, sourceFramebuffer);
            const scale = actor.get_resource_scale();
            const blitSrcX = Math.max(0, Math.round(geom.sourceX + bounds.x * scale));
            const blitSrcY = Math.max(0, Math.round(geom.sourceY + bounds.y * scale));

            const fbW = sourceFramebuffer.get_width ? sourceFramebuffer.get_width() : 0;
            const fbH = sourceFramebuffer.get_height ? sourceFramebuffer.get_height() : 0;
            const maxW = fbW > 0 ? Math.max(0, fbW - blitSrcX) : this.downTargets[0].usedWidth;
            const maxH = fbH > 0 ? Math.max(0, fbH - blitSrcY) : this.downTargets[0].usedHeight;
            const blitW = Math.min(this.downTargets[0].usedWidth, maxW);
            const blitH = Math.min(this.downTargets[0].usedHeight, maxH);

            if (blitW > 0 && blitH > 0) {
                if (sourceFramebuffer.blit) {
                    sourceFramebuffer.blit(
                        this.downTargets[0].framebuffer,
                        blitSrcX, blitSrcY,
                        0, 0,
                        blitW, blitH
                    );
                } else if (Cogl.blit_framebuffer) {
                    Cogl.blit_framebuffer(
                        sourceFramebuffer,
                        this.downTargets[0].framebuffer,
                        blitSrcX, blitSrcY,
                        0, 0,
                        blitW, blitH
                    );
                }
            }
        } else {
            const actorLayer = Clutter.LayerNode.new_to_framebuffer(
                this.downTargets[0].framebuffer,
                this.downTargets[0].layerPipeline
            );
            actorLayer.set_name('WackKawase source');
            actorLayer.add_child(new Clutter.ActorNode(actor, 255));
            node.add_child(actorLayer);
        }

        for (let level = 1; level <= passes; level++) {
            if (passes === 1 && blend === 0)
                break;
            addPassNode(
                node,
                this.downTargets[level],
                this.downPipelines[level],
                bounds,
                `WackKawase downsample ${level}`
            );
        }

        for (let level = passes - 1; level >= 1; level--) {
            addPassNode(
                node,
                this.upTargets[level],
                this.upPipelines[level],
                bounds,
                `WackKawase upsample ${level}`
            );
        }
    }

    releaseTargets() {
        this.downTargets = [];
        this.upTargets = [];
        this.downPipelines = [];
        this.upPipelines = [];
        this.outputPipeline = null;
        this.maskTarget = null;
        this.regions.clear();
        this.width = 0;
        this.height = 0;
        this.logicalWidth = 0;
        this.logicalHeight = 0;
        this.capacityWidth = 0;
        this.capacityHeight = 0;
        this.context = null;
        this.appliedSampling = null;
        this.appliedOutputUniforms = null;
        this.blurValid = false;
        this._lastX = null;
        this._lastY = null;
        this._lastW = null;
        this._lastH = null;
    }

    destroy() {
        this.releaseTargets();
    }
});

let paintedStageView = null;
let stageViewTrackingCount = 0;
let stageBeforePaintId = 0;
let stageAfterPaintId = 0;

export function retainStageViewTracking() {
    stageViewTrackingCount++;
    if (stageViewTrackingCount === 1 && typeof global !== 'undefined' && global.stage) {
        stageBeforePaintId = global.stage.connect('before-paint', (_, view) => {
            paintedStageView = view;
        });
        stageAfterPaintId = global.stage.connect('after-paint', () => {
            paintedStageView = null;
        });
    }
}

export function releaseStageViewTracking() {
    stageViewTrackingCount = Math.max(0, stageViewTrackingCount - 1);
    if (stageViewTrackingCount === 0 && typeof global !== 'undefined' && global.stage) {
        if (stageBeforePaintId) {
            global.stage.disconnect(stageBeforePaintId);
            stageBeforePaintId = 0;
        }
        if (stageAfterPaintId) {
            global.stage.disconnect(stageAfterPaintId);
            stageAfterPaintId = 0;
        }
        paintedStageView = null;
    }
}

export const ClockGlyphBlurEffect = GObject.registerClass({
    GTypeName: 'WackClockGlyphBlurEffect',
    Properties: {
        'radius': GObject.ParamSpec.double(
            'radius', null, null,
            GObject.ParamFlags.READWRITE,
            0, 200, 30
        ),
        'brightness': GObject.ParamSpec.double(
            'brightness', null, null,
            GObject.ParamFlags.READWRITE,
            0, 1, 0.6
        ),
        'opacity-factor': GObject.ParamSpec.double(
            'opacity-factor', null, null,
            GObject.ParamFlags.READWRITE,
            0, 1, 1.0
        ),
        'tint-r': GObject.ParamSpec.double(
            'tint-r', null, null,
            GObject.ParamFlags.READWRITE,
            0, 1, 1.0
        ),
        'tint-g': GObject.ParamSpec.double(
            'tint-g', null, null,
            GObject.ParamFlags.READWRITE,
            0, 1, 1.0
        ),
        'tint-b': GObject.ParamSpec.double(
            'tint-b', null, null,
            GObject.ParamFlags.READWRITE,
            0, 1, 1.0
        ),
        'tint-alpha': GObject.ParamSpec.double(
            'tint-alpha', null, null,
            GObject.ParamFlags.READWRITE,
            0, 1, 0.4
        ),
        'live': GObject.ParamSpec.boolean(
            'live', null, null,
            GObject.ParamFlags.READWRITE,
            false
        ),
    },
}, class ClockGlyphBlurEffect extends Clutter.OffscreenEffect {
    _init(params = {}) {
        super._init();
        retainStageViewTracking();
        this.downTargets = [];
        this.upTargets = [];
        this.downPipelines = [];
        this.upPipelines = [];
        this.outputPipeline = null;
        this.regions = new Map();
        this.width = 0;
        this.height = 0;
        this.capacityWidth = 0;
        this.capacityHeight = 0;
        this.context = null;
        this.appliedSampling = null;
        this.blurValid = false;
        this._lastX = null;
        this._lastY = null;
        this._lastW = null;
        this._lastH = null;

        this._radius = params.radius ?? 30;
        this._brightness = params.brightness ?? 0.6;
        this._opacity_factor = params.opacity_factor ?? 1.0;
        this._live = params.live ?? false;
        this._tint_r = params.tint_r ?? 1.0;
        this._tint_g = params.tint_g ?? 1.0;
        this._tint_b = params.tint_b ?? 1.0;
        this._tint_alpha = params.tint_alpha ?? 0.4;
    }

    get mode() { return 2; }
    set mode(_) {}

    get tint_r() { return this._tint_r; }
    set tint_r(val) {
        const clamped = Math.max(0, Math.min(1, val));
        if (this._tint_r === clamped) return;
        this._tint_r = clamped;
        if (this.outputPipeline)
            setFloat(this.outputPipeline, 'tint_r', clamped);
        this.queue_repaint();
        this.notify('tint-r');
    }

    get tint_g() { return this._tint_g; }
    set tint_g(val) {
        const clamped = Math.max(0, Math.min(1, val));
        if (this._tint_g === clamped) return;
        this._tint_g = clamped;
        if (this.outputPipeline)
            setFloat(this.outputPipeline, 'tint_g', clamped);
        this.queue_repaint();
        this.notify('tint-g');
    }

    get tint_b() { return this._tint_b; }
    set tint_b(val) {
        const clamped = Math.max(0, Math.min(1, val));
        if (this._tint_b === clamped) return;
        this._tint_b = clamped;
        if (this.outputPipeline)
            setFloat(this.outputPipeline, 'tint_b', clamped);
        this.queue_repaint();
        this.notify('tint-b');
    }

    get tint_alpha() { return this._tint_alpha; }
    set tint_alpha(val) {
        const clamped = Math.max(0, Math.min(1, val));
        if (this._tint_alpha === clamped) return;
        this._tint_alpha = clamped;
        if (this.outputPipeline) {
            setFloat(this.outputPipeline, 'clock_tint_alpha', clamped);
            setFloat(this.outputPipeline, 'text_alpha', clamped);
        }
        this.queue_repaint();
        this.notify('tint-alpha');
    }

    get live() { return this._live; }
    set live(val) {
        const boolVal = Boolean(val);
        if (this._live === boolVal) return;
        this._live = boolVal;
        this.blurValid = false;
        this.queue_repaint();
        this.notify('live');
    }

    get radius() { return this._radius; }
    set radius(val) {
        const clamped = Math.max(0, Math.min(200, val));
        if (this._radius === clamped) return;
        this._radius = clamped;
        this.blurValid = false;
        this.queue_repaint();
        this.notify('radius');
    }

    get brightness() { return this._brightness; }
    set brightness(val) {
        const clamped = Math.max(0, Math.min(1, val));
        if (this._brightness === clamped) return;
        this._brightness = clamped;
        if (this.outputPipeline)
            setFloat(this.outputPipeline, 'brightness', clamped);
        this.queue_repaint();
        this.notify('brightness');
    }

    get opacity_factor() { return this._opacity_factor; }
    set opacity_factor(val) {
        const clamped = Math.max(0, Math.min(1, val));
        if (this._opacity_factor === clamped) return;
        this._opacity_factor = clamped;
        if (this.outputPipeline)
            setFloat(this.outputPipeline, 'opacity_factor', clamped);
        this.queue_repaint();
        this.notify('opacity-factor');
    }

    set(params = {}) {
        for (const [key, value] of Object.entries(params)) {
            if (key in this)
                this[key] = value;
            else if (key === 'opacity_factor' || key === 'opacity-factor')
                this.opacity_factor = value;
            else if (key === 'tint_r' || key === 'tint-r')
                this.tint_r = value;
            else if (key === 'tint_g' || key === 'tint-g')
                this.tint_g = value;
            else if (key === 'tint_b' || key === 'tint-b')
                this.tint_b = value;
            else if (key === 'tint_alpha' || key === 'tint-alpha')
                this.tint_alpha = value;
        }
    }

    updateOutputUniforms(width, height, resourceScale, textAlpha) {
        const pipeline = this.outputPipeline;
        setFloat(pipeline, 'brightness', this._brightness);
        setFloat(pipeline, 'opacity_factor', this._opacity_factor);
        setFloat(pipeline, 'output_width', width);
        setFloat(pipeline, 'output_height', height);
        setFloat(pipeline, 'tint_r', this._tint_r);
        setFloat(pipeline, 'tint_g', this._tint_g);
        setFloat(pipeline, 'tint_b', this._tint_b);
        setFloat(pipeline, 'clock_tint_alpha', this._tint_alpha);
        setFloat(pipeline, 'text_alpha', textAlpha);
        setFloat(pipeline, 'wack_resource_scale', resourceScale);
    }

    ensureTargets(context, width, height, passes, glyphTexture) {
        if (this.context !== context || width > this.capacityWidth || height > this.capacityHeight) {
            this.releaseTargets();
            this.capacityWidth = Math.ceil(width * 1.25);
            this.capacityHeight = Math.ceil(height * 1.25);
            this.context = context;
        }

        for (let level = this.downTargets.length; level <= passes; level++) {
            this.downTargets.push(createRenderTarget(
                context,
                levelSize(this.capacityWidth, level),
                levelSize(this.capacityHeight, level)
            ));
        }

        for (let level = Math.max(1, this.downPipelines.length); level <= passes; level++) {
            this.downPipelines[level] = this.createPass(
                this.downTargets[level - 1],
                context,
                DOWNSAMPLE_DECLARATIONS,
                DOWNSAMPLE_CODE
            );
        }

        for (let level = Math.max(1, this.upTargets.length); level < passes; level++) {
            this.upTargets[level] = createRenderTarget(
                context,
                levelSize(this.capacityWidth, level),
                levelSize(this.capacityHeight, level)
            );
            this.upPipelines[level] = this.createPass(
                this.downTargets[level + 1],
                context,
                UPSAMPLE_DECLARATIONS,
                UPSAMPLE_CODE,
                this.downTargets[level]
            );
        }

        if (!this.outputPipeline) {
            this.outputPipeline = this.createPass(
                this.downTargets[1],
                context,
                GLYPH_OUTPUT_DECLARATIONS,
                GLYPH_OUTPUT_CODE,
                this.downTargets[0],
                true,
                glyphTexture
            );
        } else if (glyphTexture) {
            this.outputPipeline.set_layer_texture(2, glyphTexture);
        }

        const resized = this.width !== width || this.height !== height;
        if (!resized)
            return;

        this.blurValid = false;

        this.downTargets.forEach((target, level) =>
            resizeRenderTarget(target, level, width, height));
        this.upTargets.forEach((target, level) =>
            resizeRenderTarget(target, level, width, height));

        this.updateRegions(glyphTexture, width, height, passes);

        const bounds = { x: 0, y: 0, width, height };
        this.downTargets.forEach(target => projectRenderTarget(target, bounds));
        this.upTargets.forEach(target => projectRenderTarget(target, bounds));

        this.width = width;
        this.height = height;
    }

    updateRegions(glyphTexture, width, height, passes) {
        this.downPipelines.forEach((pipeline, level) =>
            this.regions.get(pipeline).source.update(this.downTargets[level - 1]));
        this.upPipelines.forEach((pipeline, level) => {
            const regs = this.regions.get(pipeline);
            regs.source.update(this.downTargets[level + 1]);
            regs.original.update(this.downTargets[level]);
        });
        const outputRegions = this.regions.get(this.outputPipeline);
        if (outputRegions) {
            const source = passes === 1 ? this.downTargets[1] : (this.upTargets[1] ?? this.downTargets[1]);
            outputRegions.source.update(source);
            outputRegions.original.update(this.downTargets[0]);
            if (outputRegions.mask && glyphTexture) {
                outputRegions.mask.update({
                    usedWidth: width,
                    usedHeight: height,
                    width,
                    height,
                });
            }
        }
    }

    createPass(source, context, declarations, code, original = null, outputPass = false, mask = null) {
        const pipeline = createPassPipeline(context, source.texture, declarations, code);
        this.regions.set(pipeline, {
            source: new TextureRegion(pipeline, SOURCE_REGION),
            original: original ? new TextureRegion(pipeline, ORIGINAL_REGION) : null,
            mask: mask ? new TextureRegion(pipeline, MASK_REGION) : null,
        });
        setVector2(pipeline, 'halfpixel', 0.5 / source.width, 0.5 / source.height);
        if (original) {
            pipeline.set_layer_texture(1, original.texture);
            pipeline.set_layer_filters(1, Cogl.PipelineFilter.LINEAR, Cogl.PipelineFilter.LINEAR);
            pipeline.set_layer_wrap_mode(1, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
            setFloat(pipeline, 'level_blend', 1);
        }
        if (mask) {
            pipeline.set_layer_texture(2, mask);
            pipeline.set_layer_filters(2, Cogl.PipelineFilter.LINEAR, Cogl.PipelineFilter.LINEAR);
            pipeline.set_layer_wrap_mode(2, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
        }
        if (outputPass) {
            setFloat(pipeline, 'brightness', this._brightness);
            setFloat(pipeline, 'opacity_factor', this._opacity_factor);
        }
        return pipeline;
    }

    configureUpsample(pipeline, level, passes, blend) {
        const source = level === passes - 1
            ? this.downTargets[level + 1] : this.upTargets[level + 1];
        pipeline.set_layer_texture(0, source.texture);
        setFloat(pipeline, 'level_blend', level === passes - 1 ? blend : 1);
    }

    updateSampling(passes, blend, glyphTexture, width, height) {
        if (this.appliedSampling?.passes === passes
            && this.appliedSampling.blend === blend)
            return;

        for (let level = passes - 1; level >= 1; level--)
            this.configureUpsample(this.upPipelines[level], level, passes, blend);
        this.configureUpsample(this.outputPipeline, 0, passes, blend);
        this.updateRegions(glyphTexture, width, height, passes);
        this.appliedSampling = { passes, blend };
        this.blurValid = false;
    }

    invalidate() {
        this.blurValid = false;
        this._lastX = null;
        this._lastY = null;
        this._lastW = null;
        this._lastH = null;
        this.queue_repaint();
    }

    vfunc_paint_target(node, paintContext) {
        const actor = this.get_actor();
        if (!actor || actor.width <= 0 || actor.height <= 0)
            return;

        const paintOpacity = actor.get_paint_opacity();
        if (paintOpacity === 0)
            return;

        if (this._radius === 0 || this._opacity_factor === 0) {
            super.vfunc_paint_target(node, paintContext);
            this.blurValid = false;
            return;
        }

        const targetTexture = this.get_texture();
        if (!targetTexture) {
            super.vfunc_paint_target(node, paintContext);
            return;
        }

        // Prefer paintContext.get_stage_view() (GNOME 46+) so that the stage
        // framebuffer is obtained reliably even in GDM and rest-lockscreen
        // contexts where the module-level paintedStageView sentinel may still
        // be null at the time vfunc_paint_target fires.
        const stageView = (paintContext?.get_stage_view ? paintContext.get_stage_view() : null) ?? paintedStageView;
        const sourceFramebuffer = stageView?.get_framebuffer ? stageView.get_framebuffer() : null;
        const context = sourceFramebuffer ? sourceFramebuffer.get_context() : this.context;
        if (!context) {
            super.vfunc_paint_target(node, paintContext);
            return;
        }

        const targetWidth = targetTexture.get_width();
        const targetHeight = targetTexture.get_height();
        if (targetWidth <= 0 || targetHeight <= 0) {
            super.vfunc_paint_target(node, paintContext);
            return;
        }

        const scale = actor.get_resource_scale();
        const themeScale = St.ThemeContext.get_for_stage(actor.get_stage()).scale_factor;
        const { passes, blend } = getKawaseConfiguration(this._radius * themeScale * scale);

        this.ensureTargets(context, targetWidth, targetHeight, passes, targetTexture);
        this.updateSampling(passes, blend, targetTexture, targetWidth, targetHeight);

        const [originX, originY] = actor.get_transformed_position();
        const [w, h] = actor.get_transformed_size();
        // get_layout() requires an MtkRectangle* in-param in Mutter 18+; use the GObject property.
        const layout = stageView?.layout ?? { x: 0, y: 0 };
        const viewScale = stageView?.get_scale ? stageView.get_scale() : scale;
        let viewX = Math.round(originX - layout.x);
        let viewY = Math.round(originY - layout.y);

        const positionChanged = (this._lastX !== viewX || this._lastY !== viewY ||
            this._lastW !== w || this._lastH !== h);

        const needsCapture = this._live || !this.blurValid || positionChanged;

        if (needsCapture && sourceFramebuffer) {
            const captured = this.addBlurPasses(
                node,
                actor,
                targetWidth,
                targetHeight,
                passes,
                blend,
                sourceFramebuffer,
                viewX,
                viewY,
                viewScale
            );
            if (captured) {
                this.blurValid = true;
                this._lastX = viewX;
                this._lastY = viewY;
                this._lastW = w;
                this._lastH = h;
            }
        } else if (needsCapture && !sourceFramebuffer && !this.blurValid) {
            // No stage framebuffer available yet (e.g. GDM or rest lockscreen first
            // paint before the before-paint signal has fired) and no prior cached
            // capture exists.  Rendering the output pipeline against an empty
            // downTargets[0] would produce an invisible glyph, so fall back to the
            // plain OffscreenEffect render which paints the text normally.
            super.vfunc_paint_target(node, paintContext);
            return;
        }

        this.updateOutputUniforms(targetWidth, targetHeight, scale, this._tint_alpha);
        setPaintOpacity(this.outputPipeline, paintOpacity / 255);

        const outputNode = new Clutter.PipelineNode(this.outputPipeline);
        outputNode.set_name('WackClockGlyph output');
        addRectangle(outputNode, 0, 0, targetWidth, targetHeight);
        node.add_child(outputNode);
    }

    addBlurPasses(node, actor, targetWidth, targetHeight, passes, blend, sourceFramebuffer, viewX, viewY, viewScale) {
        if (!sourceFramebuffer)
            return false;

        const fbW = sourceFramebuffer.get_width ? sourceFramebuffer.get_width() : 0;
        const fbH = sourceFramebuffer.get_height ? sourceFramebuffer.get_height() : 0;
        if (fbW <= 0 || fbH <= 0)
            return false;

        const blitSrcX = Math.max(0, Math.round(viewX * viewScale));
        const blitSrcY = Math.max(0, Math.round(viewY * viewScale));
        const maxW = Math.max(0, fbW - blitSrcX);
        const maxH = Math.max(0, fbH - blitSrcY);
        const blitW = Math.min(targetWidth, maxW);
        const blitH = Math.min(targetHeight, maxH);

        if (blitW <= 0 || blitH <= 0)
            return false;

        this.downTargets[0].framebuffer.clear4f(Cogl.BufferBit.COLOR, 0, 0, 0, 0);

        if (sourceFramebuffer.blit) {
            sourceFramebuffer.blit(
                this.downTargets[0].framebuffer,
                blitSrcX, blitSrcY,
                0, 0,
                blitW, blitH
            );
        } else if (Cogl.blit_framebuffer) {
            Cogl.blit_framebuffer(
                sourceFramebuffer,
                this.downTargets[0].framebuffer,
                blitSrcX, blitSrcY,
                0, 0,
                blitW, blitH
            );
        }

        const bounds = { x: 0, y: 0, width: targetWidth, height: targetHeight };
        for (let level = 1; level <= passes; level++) {
            if (passes === 1 && blend === 0)
                break;
            addPassNode(
                node,
                this.downTargets[level],
                this.downPipelines[level],
                bounds,
                `WackClockGlyph downsample ${level}`
            );
        }

        for (let level = passes - 1; level >= 1; level--) {
            addPassNode(
                node,
                this.upTargets[level],
                this.upPipelines[level],
                bounds,
                `WackClockGlyph upsample ${level}`
            );
        }

        return true;
    }

    releaseTargets() {
        this.downTargets = [];
        this.upTargets = [];
        this.downPipelines = [];
        this.upPipelines = [];
        this.outputPipeline = null;
        this.regions.clear();
        this.width = 0;
        this.height = 0;
        this.capacityWidth = 0;
        this.capacityHeight = 0;
        this.context = null;
        this.appliedSampling = null;
        this.blurValid = false;
        this._lastX = null;
        this._lastY = null;
        this._lastW = null;
        this._lastH = null;
    }

    destroy() {
        this.releaseTargets();
        releaseStageViewTracking();
    }
});

export function createKawaseBlurEffect(params = {}) {
    const effect = params.mode === 2
        ? new ClockGlyphBlurEffect(params)
        : new KawaseBlurEffect(params);
    if (params.name)
        effect.name = params.name;
    return effect;
}

export function createClockGlyphBlurEffect(params = {}) {
    return createKawaseBlurEffect({ ...params, mode: 2 });
}
