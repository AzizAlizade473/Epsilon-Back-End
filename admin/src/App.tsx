import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider, useRouteError, type RouteObject } from 'react-router';
import { AuthProvider } from './api/auth';
import { queryRetry } from './api/hooks';
import { StatusPanel } from './components/data';
import { Shell } from './components/Shell';

const page = (load: () => Promise<{ Component: () => React.JSX.Element }>) => ({
  lazy: async () => ({ Component: (await load()).Component }),
});

function RouteError() {
  return <StatusPanel error={useRouteError()} onRetry={() => window.location.reload()} />;
}

export const routes: RouteObject[] = [
  {
    path: '/',
    Component: Shell,
    ErrorBoundary: RouteError,
    children: [
      { index: true, ...page(() => import('./pages/Overview')) },
      { path: 'users', ...page(() => import('./pages/Users')) },
      { path: 'users/:id', ...page(() => import('./pages/UserDetail')) },
      { path: 'restaurants', ...page(() => import('./pages/Restaurants')) },
      { path: 'restaurants/:key', ...page(() => import('./pages/RestaurantDetail')) },
      { path: 'dishes', ...page(() => import('./pages/Dishes')) },
      { path: 'dishes/:key', ...page(() => import('./pages/DishDetail')) },
      { path: 'reviews', ...page(() => import('./pages/Reviews')) },
      { path: 'receipts', ...page(() => import('./pages/Receipts')) },
      { path: 'receipts/:id', ...page(() => import('./pages/ReceiptDetail')) },
      { path: 'cashback', ...page(() => import('./pages/Cashback')) },
      { path: 'notifications', ...page(() => import('./pages/Notifications')) },
      { path: 'product', ...page(() => import('./pages/Product')) },
      { path: 'health', ...page(() => import('./pages/Health')) },
      { path: 'costs', ...page(() => import('./pages/Costs')) },
      { path: 'reports', ...page(() => import('./pages/Reports')) },
      { path: 'audit', ...page(() => import('./pages/Audit')) },
      { path: 'settings', ...page(() => import('./pages/Settings')) },
      { path: '*', ...page(() => import('./pages/NotFound')) },
    ],
  },
];

const client = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: queryRetry } } });
const router = createBrowserRouter(routes);

export default function App() {
  return (
    <QueryClientProvider client={client}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  );
}
