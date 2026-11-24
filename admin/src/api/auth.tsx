import { createContext, useContext, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, setCsrfToken } from './client';
import { adminSchema, type Session } from './schemas';
import { z } from 'zod';
import { StatusScreen } from '../components/data';
import { PageSkeleton } from '../components/data';

type Auth = { admin: Session['admin']; can: (permission: string) => boolean; signOut: () => Promise<void> };
export const AuthContext = createContext<Auth | null>(null);

export function useAuth(): Auth {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}

/** Test/Provider helper: permissions come from the server; the client only hides UI. */
export const makeAuth = (admin: Session['admin']): Auth => ({
  admin,
  can: (p) => admin.permissions.includes(p),
  signOut: async () => undefined,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['session'],
    queryFn: async () => {
      // The gateway already authenticated the user; POST /session mints the admin session.
      setCsrfToken((await api('POST', '/session', adminSchema)).csrfToken);
      const me = await api('GET', '/me', adminSchema);
      setCsrfToken(me.csrfToken);
      return me;
    },
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });
  if (q.isPending) return <PageSkeleton screen />;
  if (q.isError) return <StatusScreen error={q.error instanceof ApiError ? q.error : new ApiError(0, 'network', '')} bootstrap />;
  const admin = q.data.admin;
  const value: Auth = {
    admin,
    can: (p) => admin.permissions.includes(p),
    signOut: async () => {
      try {
        await api('POST', '/logout', z.unknown());
      } finally {
        setCsrfToken(null);
        qc.clear();
        window.location.assign('/');
      }
    },
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
