import type { HealthDto } from "../../shared/api-types.ts";
import type { HealthRepository } from "../repositories/health.repository.ts";

export class HealthService {
  constructor(
    private readonly repository: HealthRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async check(): Promise<HealthDto> {
    const dbOk = await this.repository.pingDatabase();
    return {
      status: dbOk ? "ok" : "degraded",
      database: dbOk ? "ok" : "unavailable",
      time: this.now().toISOString(),
    };
  }
}
