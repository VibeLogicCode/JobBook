/**
 * On the LIST routes only, never on a `[id]` detail route.
 *
 * A route with a loading boundary streams, and a streamed response has already
 * sent its status line by the time the page body runs -- so a `notFound()`
 * raised inside a detail route would render the right screen under a 200. The
 * lists never call `notFound()`, and they are where the wait actually is: an
 * unfiltered table against a cold database on a NAS.
 */
export { RouteLoading as default } from '@/components/ui/RouteLoading';
