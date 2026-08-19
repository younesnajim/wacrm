import {
  Coins,
  FileText,
  KeyRound,
  LayoutGrid,
  Palette,
  PlugZap,
  Shield,
  Tags,
  User,
  UsersRound,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { AccountRole } from '@/lib/auth/roles';

/**
 * Settings information architecture for the redesigned page.
 *
 * The flat tab strip became a grouped left rail with a new Overview
 * landing. The URL query param stays `?tab=` (deep-linkable, and it
 * keeps the existing links in sidebar.tsx / header.tsx working) — we
 * just map the old values onto the new sections.
 */
export const SETTINGS_SECTIONS = [
  'overview',
  'profile',
  'security',
  'appearance',
  'whatsapp',
  'templates',
  'quick-replies',
  'fields',
  'deals',
  'members',
  'api',
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const DEFAULT_SECTION: SettingsSection = 'overview';

/**
 * Rail grouping + access. `minRole` is the lowest account role that
 * may see the rail entry and open the section — enforced in three
 * places so hidden things never render or stay reachable:
 *   1. `settings-rail.tsx` filters the nav by rank.
 *   2. `settings/page.tsx` wraps each panel in `<RequireRole>`.
 *   3. Nothing server-side needs a parallel check here — every
 *      settings panel's own writes already go through requireRole()
 *      API routes or role-gated RLS, which are the real gate. This
 *      is UI-only: keeping the nav/redirect fallback in sync means
 *      an under-privileged user just never gets an actionable
 *      element pointed at a 403.
 */
export interface SectionMeta {
  id: SettingsSection;
  label: string;
  icon: LucideIcon;
  group: 'top' | 'account' | 'workspace';
  minRole: AccountRole;
}

export const SECTION_META: Record<SettingsSection, SectionMeta> = {
  overview: { id: 'overview', label: 'Overview', icon: LayoutGrid, group: 'top', minRole: 'viewer' },
  profile: { id: 'profile', label: 'Your profile', icon: User, group: 'account', minRole: 'viewer' },
  security: { id: 'security', label: 'Login & security', icon: Shield, group: 'account', minRole: 'viewer' },
  appearance: { id: 'appearance', label: 'Appearance', icon: Palette, group: 'account', minRole: 'viewer' },
  whatsapp: { id: 'whatsapp', label: 'WhatsApp', icon: PlugZap, group: 'workspace', minRole: 'admin' },
  templates: { id: 'templates', label: 'Templates', icon: FileText, group: 'workspace', minRole: 'agent' },
  'quick-replies': { id: 'quick-replies', label: 'Quick replies', icon: Zap, group: 'workspace', minRole: 'agent' },
  fields: { id: 'fields', label: 'Fields & tags', icon: Tags, group: 'workspace', minRole: 'admin' },
  deals: { id: 'deals', label: 'Deals & currency', icon: Coins, group: 'workspace', minRole: 'admin' },
  members: { id: 'members', label: 'Team members', icon: UsersRound, group: 'workspace', minRole: 'admin' },
  api: { id: 'api', label: 'API keys', icon: KeyRound, group: 'workspace', minRole: 'admin' },
};

export const RAIL_GROUPS: { label: string | null; group: SectionMeta['group'] }[] = [
  { label: null, group: 'top' },
  { label: 'Account', group: 'account' },
  { label: 'Workspace', group: 'workspace' },
];

function isSection(value: string | null): value is SettingsSection {
  return !!value && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

/**
 * Resolve a raw `?tab=` value to a section. Legacy tabs from the old
 * flat layout collapse onto their new home (Tags + Custom fields → the
 * merged "Fields & tags" section). Anything unknown falls back to the
 * Overview landing.
 */
export function resolveSection(raw: string | null): SettingsSection {
  if (raw === 'tags' || raw === 'custom-fields') return 'fields';
  if (isSection(raw)) return raw;
  return DEFAULT_SECTION;
}
