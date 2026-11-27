import { Injectable } from '@nestjs/common';

/** Vira true no SIGTERM, assim o readiness falha primeiro e o balanceador drena a instância. */
@Injectable()
export class LifecycleState {
  shuttingDown = false;
}
