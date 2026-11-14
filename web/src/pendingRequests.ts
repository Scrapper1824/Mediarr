import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/** How many requests wait for an admin (the sidebar badge). */
export function usePendingRequests(enabled: boolean) {
  return useQuery({
    queryKey: ['requests', 'count'],
    queryFn: () => api.get<{ pending: number }>('/api/requests/count'),
    enabled,
    refetchInterval: 30_000,
  });
}
