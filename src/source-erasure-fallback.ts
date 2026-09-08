import type {sourceErasureWork} from './source-erasure.js';
import {ServiceError,type SourceErasurePlan} from './types.js';

/** A lexical nomination is neither a deletion verdict nor an independence
 * certificate. Even an authorized target's own source can contain surviving
 * neighbors, while a value-free source can restate the erased claim. Without
 * semantic review neither whole-source erasure nor implicit retention is safe.
 *
 * An empty work set is already complete. Nonempty work must fail atomically;
 * the caller must not turn this refusal into another deterministic fallback.
 * This helper does not repair model output, resample verdicts or authorize a
 * restoration. Explicit restoration is resolved by sourceErasureWork itself.
 */
export function conservativeSourceErasureFallback(work:ReturnType<typeof sourceErasureWork>):SourceErasurePlan{
 if(work.candidates.length)throw new ServiceError('EVIDENCE_VALIDATION',
  `Source erasure semantic review required for ${work.candidates.length} unresolved candidate pairs; lexical nomination cannot authorize erasure or retention`);
 return {fingerprint:work.fingerprint,decisions:[]};
}
