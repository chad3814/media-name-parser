/**
 * A provider failure that will fail identically on every retry.
 *
 * Its own module, and provider-agnostic, because two layers that must not know
 * about TMDB need to recognise it: `lib/resolve/pipeline.ts` flattens every
 * provider error into a `PipelineResult`, and `lib/jobs/sweep.ts` decides from
 * that result whether a job is worth another attempt. A rejected credential is
 * the case the spec calls out -- "the sweeper does not grind against a bad
 * key" -- and the only way the sweeper can know is if terminality survives the
 * flattening, which means the marker has to live somewhere both can import
 * without either importing a provider.
 */
export class ProviderAuthFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderAuthFailed';
  }
}
