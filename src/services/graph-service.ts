import { getEventDetail, listSources } from "../db/repositories.js";
import { config } from "../config/env.js";

export class GraphService {
  async getEvent(eventId: string, tenantId = config.DEFAULT_TENANT_ID) {
    return getEventDetail({ eventId, tenantId });
  }

  async listSources(input: { limit?: number; cursor?: string }, tenantId = config.DEFAULT_TENANT_ID) {
    return listSources({
      tenantId,
      limit: Math.min(Math.max(input.limit ?? 50, 1), 100),
      cursor: input.cursor
    });
  }
}

export const graphService = new GraphService();
