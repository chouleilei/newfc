/** T-7 项目档案(360 视图)。 */
import { api } from './client';
import type { ProjectProfileDto } from '@contracts/project-profile';

export type * from '@contracts/project-profile';

export const projectProfileApi = {
  get: (id: number) => api.get<ProjectProfileDto>(`/master/projects/${id}/profile`),
};
