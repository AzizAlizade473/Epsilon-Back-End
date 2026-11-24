import { ApiError } from '../api/client';
import { StatusPanel } from '../components/data';

export function Component() {
  return <StatusPanel error={new ApiError(404, 'http', 'Not found')} />;
}
