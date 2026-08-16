/**
 * Driver selection. One switch, resolved once at boot.
 *
 * Adding the real processor is: a new file next to sandbox.ts implementing
 * `PaymentGateway`, one case here, and `GATEWAY_DRIVER=…` in the environment.
 * Nothing in routes/ or services/ changes, because nothing in routes/ or
 * services/ has ever seen a processor's field names.
 */

import { env } from '../env';
import { SandboxGateway } from './sandbox';
import { GatewayUnavailableError, type PaymentGateway } from './types';

function build(): PaymentGateway {
  switch (env.gatewayDriver) {
    case 'sandbox':
      return new SandboxGateway();
    default: {
      // Exhaustive: adding a driver to the env enum without wiring it here is a
      // type error, not a runtime surprise on the first top-up.
      const never: never = env.gatewayDriver;
      throw new Error(`Unknown GATEWAY_DRIVER: ${String(never)}`);
    }
  }
}

export const gateway: PaymentGateway = build();

/** The sandbox's extra controls, when the sandbox is what is configured. */
export function sandboxGateway(): SandboxGateway | null {
  return gateway instanceof SandboxGateway ? gateway : null;
}

/**
 * Never let a third party hold a database transaction open indefinitely.
 *
 * `POST /topups` calls the gateway INSIDE its transaction on purpose (see
 * services/topup.ts), which is only defensible with a hard ceiling on how long
 * that call may take.
 */
export async function withGatewayTimeout<T>(
  what: string,
  work: () => Promise<T>,
  timeoutMs = env.gatewayTimeoutMs,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new GatewayUnavailableError(`${what} did not answer in ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export * from './types';
