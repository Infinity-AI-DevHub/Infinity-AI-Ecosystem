/**
 * Navigation model: product areas and the modules inside them.
 *
 * The shell, the command palette, breadcrumbs, favourites and recents all read this one
 * registry, so a module is added in exactly one place. Capabilities here only hide
 * entries a role cannot use - the API authorizes every call independently.
 *
 * An area appears only when it contains at least one module the person can open. Areas
 * the product does not have modules for yet (Engineering, Security) are not
 * listed: an entry that leads to an empty page is worse than no entry.
 */
import {
  BarChart3,
  Bell,
  BellRing,
  BookText,
  CalendarDays,
  CheckSquare,
  Clock,
  Files as FilesIcon,
  Handshake,
  LayoutDashboard,
  Megaphone,
  MessageSquareText,
  MessagesSquare,
  Palmtree,
  Search as SearchIcon,
  Send,
  Settings as SettingsIcon,
  ShieldCheck,
  SlidersHorizontal,
  Target,
  Users,
  Wallet,
  Briefcase,
  LifeBuoy,
  BookOpen,
  GitPullRequestArrow,
  HardDrive,
  Ticket,
  Settings2,
  Building2,
  type LucideIcon,
} from 'lucide-react';

export type BadgeKey = 'chat' | 'tasks' | 'approvals' | 'invoices' | 'announcements' | 'leave';

export type NavModule = {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Hides the entry when the role cannot use it; the API still enforces access. Any of a list. */
  capability?: string | string[];
  /** Which activity count, if any, badges this entry. */
  badge?: BadgeKey;
  /** Extra words the command palette matches on. */
  keywords?: string;
};

export type NavArea = {
  id: string;
  label: string;
  /** Fits under the rail icon. */
  short: string;
  icon: LucideIcon;
  modules: NavModule[];
};

export const NAV_AREAS: NavArea[] = [
  {
    id: 'command',
    label: 'Command', short: 'Home',
    icon: LayoutDashboard,
    modules: [
      { to: '/command', label: 'Command centre', icon: LayoutDashboard, keywords: 'home dashboard today' },
      { to: '/reminders', label: 'Reminders', icon: BellRing, capability: 'reminder.manage' },
    ],
  },
  {
    id: 'communication',
    label: 'Communication', short: 'Comms',
    icon: MessagesSquare,
    modules: [
      { to: '/notifications', label: 'Notifications', icon: Bell, keywords: 'alerts inbox unread activity' },
      { to: '/chat', label: 'Chat', icon: MessageSquareText, capability: 'room.join', badge: 'chat', keywords: 'channels rooms direct' },
      { to: '/meetings', label: 'Meetings', icon: CalendarDays, capability: 'calendar.read', keywords: 'calendar events schedule' },
      { to: '/announcements', label: 'Announcements', icon: Megaphone, badge: 'announcements', keywords: 'news notices' },
      { to: '/messages', label: 'Messages', icon: Send, capability: 'message.broadcast', keywords: 'broadcast email notify' },
    ],
  },
  {
    id: 'work',
    label: 'Work', short: 'Work',
    icon: Briefcase,
    modules: [
      { to: '/tasks', label: 'Tasks', icon: CheckSquare, capability: 'task.update', badge: 'tasks', keywords: 'projects todo' },
      { to: '/docs', label: 'Documents', icon: BookText, capability: 'doc.read', keywords: 'wiki pages spaces' },
      { to: '/files', label: 'Files', icon: FilesIcon, capability: 'file.read', keywords: 'folders uploads drive' },
      { to: '/approvals', label: 'Approvals', icon: ShieldCheck, capability: 'request.create', badge: 'approvals', keywords: 'requests sign off' },
      { to: '/search', label: 'Search', icon: SearchIcon, capability: 'search.query', keywords: 'find' },
      { to: '/reports', label: 'Reports', icon: BarChart3, capability: 'report.read', keywords: 'analytics' },
    ],
  },
  {
    id: 'service',
    label: 'Service', short: 'Service',
    icon: LifeBuoy,
    modules: [
      { to: '/service', label: 'Service desk', icon: Ticket, capability: 'ticket.create', keywords: 'helpdesk tickets support incidents requests it' },
      { to: '/service/knowledge', label: 'Knowledge base', icon: BookOpen, capability: 'ticket.create', keywords: 'kb articles help how to faq' },
      { to: '/service/changes', label: 'Changes', icon: GitPullRequestArrow, capability: 'change.create', keywords: 'change requests cab maintenance deployment approval' },
      { to: '/service/assets', label: 'Assets & licences', icon: HardDrive, capability: ['asset.read', 'licence.read'], keywords: 'equipment laptops licences software contracts vendors warranty' },
      { to: '/service/analytics', label: 'Support analytics', icon: BarChart3, capability: ['ticket.work', 'ticket.read'], keywords: 'sla csat satisfaction metrics' },
      { to: '/service/settings', label: 'Desk settings', icon: Settings2, capability: 'service.manage', keywords: 'queues sla categories escalation' },
    ],
  },
  {
    id: 'company',
    label: 'Company', short: 'Company',
    icon: Building2,
    modules: [
      { to: '/people', label: 'People', icon: Users, capability: 'user.read', keywords: 'employees directory staff hr' },
      { to: '/attendance', label: 'Attendance', icon: Clock, capability: 'attendance.record', keywords: 'clock in timesheet' },
      { to: '/leave', label: 'Leave', icon: Palmtree, capability: 'leave.request', badge: 'leave', keywords: 'holiday vacation time off' },
      { to: '/clients', label: 'Clients', icon: Handshake, capability: 'external_org.read', keywords: 'customers organisations portal' },
      { to: '/finance', label: 'Finance', icon: Wallet, capability: 'expense.submit', badge: 'invoices', keywords: 'expenses invoices quotations billing' },
      { to: '/growth', label: 'Growth', icon: Target, capability: 'goal.manage', keywords: 'goals okr reviews' },
    ],
  },
  {
    id: 'administration',
    label: 'Administration', short: 'Admin',
    icon: SettingsIcon,
    modules: [
      { to: '/admin', label: 'Admin', icon: SettingsIcon, capability: 'settings.read', keywords: 'roles audit company settings' },
      { to: '/settings', label: 'My settings', icon: SlidersHorizontal, keywords: 'preferences profile notifications theme signature' },
    ],
  },
];

export function allowed(module: NavModule, can: (capability: string) => boolean): boolean {
  if (!module.capability) return true;
  return Array.isArray(module.capability) ? module.capability.some(can) : can(module.capability);
}

/** Areas and modules this person can open, empty areas dropped. */
export function visibleAreas(can: (capability: string) => boolean): NavArea[] {
  return NAV_AREAS
    .map((area) => ({ ...area, modules: area.modules.filter((m) => allowed(m, can)) }))
    .filter((area) => area.modules.length > 0);
}

/** Longest-prefix match so '/docs/abc' resolves to Documents, not something shorter. */
export function locate(pathname: string): { area: NavArea; module: NavModule } | null {
  let best: { area: NavArea; module: NavModule } | null = null;
  for (const area of NAV_AREAS) {
    for (const module of area.modules) {
      const hit = pathname === module.to || pathname.startsWith(`${module.to}/`);
      if (hit && (!best || module.to.length > best.module.to.length)) best = { area, module };
    }
  }
  return best;
}

export function findModule(to: string): NavModule | undefined {
  for (const area of NAV_AREAS) {
    const found = area.modules.find((m) => m.to === to);
    if (found) return found;
  }
  return undefined;
}
