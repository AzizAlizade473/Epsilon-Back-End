import { Activity, BarChart3, Bell, FileDown, Heart, LayoutDashboard, Receipt, ScrollText, Settings, Star, Store, UtensilsCrossed, Users, Wallet, Coins, type LucideIcon } from 'lucide-react';

export type NavItem = { to: string; key: string; icon: LucideIcon; perm?: string };
export const NAV: { key: string; items: NavItem[] }[] = [
  { key: 'overview', items: [{ to: '/', key: 'overview', icon: LayoutDashboard }] },
  { key: 'customers', items: [{ to: '/users', key: 'users', icon: Users }] },
  {
    key: 'ecosystem',
    items: [
      { to: '/restaurants', key: 'restaurants', icon: Store },
      { to: '/dishes', key: 'dishes', icon: UtensilsCrossed },
      { to: '/reviews', key: 'reviews', icon: Star },
      { to: '/receipts', key: 'receipts', icon: Receipt },
      { to: '/likes', key: 'likes', icon: Heart },
    ],
  },
  { key: 'money', items: [{ to: '/cashback', key: 'cashback', icon: Wallet }] },
  {
    key: 'engagement',
    items: [
      { to: '/notifications', key: 'notifications', icon: Bell },
      { to: '/product', key: 'product', icon: BarChart3 },
    ],
  },
  {
    key: 'operations',
    items: [
      { to: '/health', key: 'health', icon: Activity },
      { to: '/costs', key: 'costs', icon: Coins },
    ],
  },
  {
    key: 'admin',
    items: [
      { to: '/reports', key: 'reports', icon: FileDown, perm: 'export' },
      { to: '/audit', key: 'audit', icon: ScrollText, perm: 'audit:read' },
      { to: '/settings', key: 'settings', icon: Settings },
    ],
  },
];
