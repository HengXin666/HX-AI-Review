// Pages Function: forward /api/* to the Worker through the API service binding. The Access JWT header
// added at the edge travels with the request, and the Worker verifies it again; nothing is trusted here.
type Env = { API: Fetcher };

export const onRequest: PagesFunction<Env> = ({ request, env }) => env.API.fetch(request);
