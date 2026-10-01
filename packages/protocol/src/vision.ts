// Lighting and vision messages: scene lighting, token light sources and senses.
import { LIGHTING_LEVELS, LIGHT_PRESET_IDS } from '@dnd/rules';
import { z } from 'zod';

const Id = z.string().min(1).max(64);
const Feet = z.number().int().min(0).max(1000);

export const LightSourceData = z.object({ preset: z.enum(LIGHT_PRESET_IDS), bright: Feet, dim: Feet });
/** Darkvision left out means "from the token's character sheet" (none for plain tokens). */
export const SensesData = z.object({ darkvision: Feet.optional(), blindsight: Feet.optional(), truesight: Feet.optional() });

export const VisionMessages = [
  /**
   * Scene lighting and vision settings. GM only. Turning dynamic fog on also turns fog of war on,
   * since explored areas are remembered in the fog.
   */
  z.object({
    type: z.literal('vision:scene'),
    sceneId: Id,
    enabled: z.boolean().optional(),
    lighting: z.enum(LIGHTING_LEVELS).optional(),
    dynamicFog: z.boolean().optional(),
  }),
  /**
   * A token's light source (null puts it out) and senses. The GM may set both; a player may light
   * or put out their own token's light.
   */
  z.object({ type: z.literal('vision:token'), tokenId: Id, light: LightSourceData.nullable().optional(), senses: SensesData.optional() }),
] as const;

export type VisionMessage = z.infer<(typeof VisionMessages)[number]>;
