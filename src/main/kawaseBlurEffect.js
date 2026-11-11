import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';
import { getKawaseConfiguration, getKawaseInputBounds } from './kawaseSampling.js';

let BlitNode = null;
try {
    BlitNode = Clutter.BlitNode;
} catch (_) {
}

export { getKawaseConfiguration, getKawaseInputBounds };

const box = new Clutter.ActorBox();
const color = new Cogl.Color();

function addRectangle(node, x, y, width, height) {
    box.init(x, y, x + width, y + height);
    node.add_rectangle(box);
}

function setPaintOpacity(pipeline, opacity) {
    color.init_from_4f(opacity, opacity, opacity, opacity);
    pipeline.set_color(color);
}

const REGION_COMPONENTS = ['scale_x', 'scale_y', 'max_x', 'max_y'];
const SOURCE_REGION = 'wack_source_region';
const ORIGINAL_REGION = 'wack_original_region';

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
            0, 1, 0
        ),
        'live': GObject.ParamSpec.boolean(
            'live', null, null,
            GObject.ParamFlags.READWRITE,
            false
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
            this.updateRegions();
        }
        this.downTargets.forEach(target => projectRenderTarget(target, bounds));
        this.upTargets.forEach(target => projectRenderTarget(target, bounds));
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
        outputRegions.source.update(this.downTargets[1]);
        outputRegions.original.update(this.downTargets[0]);
    }

    createPass(source, context, declarations, code, original = null, outputPass = false) {
        const pipeline = createPassPipeline(context, source.texture, declarations, code);
        this.regions.set(pipeline, {
            source: new TextureRegion(pipeline, SOURCE_REGION),
            original: original ? new TextureRegion(pipeline, ORIGINAL_REGION) : null,
        });
        setVector2(pipeline, 'halfpixel', 0.5 / source.width, 0.5 / source.height);
        if (original) {
            pipeline.set_layer_texture(1, original.texture);
            pipeline.set_layer_filters(1, Cogl.PipelineFilter.LINEAR, Cogl.PipelineFilter.LINEAR);
            pipeline.set_layer_wrap_mode(1, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
            setFloat(pipeline, 'level_blend', 1);
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
            const layout = stageView.get_layout();
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
            const [originX, originY] = actor.get_transformed_position();
            const stageView = paintContext?.get_stage_view ? paintContext.get_stage_view() : null;
            let srcX = Math.round(originX);
            let srcY = Math.round(originY);
            if (stageView) {
                const layout = stageView.get_layout();
                srcX -= layout.x;
                srcY -= layout.y;
            }

            const scale = actor.get_resource_scale();
            const blitSrcX = Math.max(0, Math.round(srcX + bounds.x * scale));
            const blitSrcY = Math.max(0, Math.round(srcY + bounds.y * scale));
            const targetW = this.downTargets[0].usedWidth;
            const targetH = this.downTargets[0].usedHeight;

            let blitted = false;
            if (sourceFramebuffer.blit) {
                try {
                    blitted = sourceFramebuffer.blit(
                        this.downTargets[0].framebuffer,
                        blitSrcX, blitSrcY,
                        0, 0,
                        targetW, targetH
                    );
                } catch (_) {
                    blitted = false;
                }
            }
            if (!blitted && BlitNode) {
                try {
                    let blitNode = null;
                    try {
                        blitNode = new BlitNode(sourceFramebuffer);
                    } catch (_) {
                        blitNode = BlitNode.new ? BlitNode.new(sourceFramebuffer) : null;
                    }
                    if (blitNode) {
                        blitNode.add_blit_rectangle(blitSrcX, blitSrcY, 0, 0, targetW, targetH);
                        const blitLayer = Clutter.LayerNode.new_to_framebuffer(
                            this.downTargets[0].framebuffer,
                            this.downTargets[0].layerPipeline
                        );
                        blitLayer.set_name('WackKawase background blit');
                        blitLayer.add_child(blitNode);
                        node.add_child(blitLayer);
                        blitted = true;
                    }
                } catch (_) {
                    blitted = false;
                }
            }
            if (!blitted) {
                try {
                    const blitFn = sourceFramebuffer.blit
                        ? (s, ...a) => s.blit(...a)
                        : Cogl.blit_framebuffer;
                    if (blitFn) {
                        blitFn(sourceFramebuffer, this.downTargets[0].framebuffer,
                               blitSrcX, blitSrcY, 0, 0, targetW, targetH);
                    }
                } catch (_) {
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

export function createKawaseBlurEffect(params = {}) {
    try {
        const effect = new KawaseBlurEffect(params);
        if (params.name)
            effect.name = params.name;
        return effect;
    } catch (_) {
        return new Shell.BlurEffect({ name: 'blur', ...params });
    }
}
