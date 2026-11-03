import axios from "axios";

/**
 * People hand this server URLs to read, so a host can answer with as much as it likes, as slowly as
 * it likes. Nothing an adapter needs comes close to this, and a response only ever gets buffered up
 * to here. A streamed response isn't buffered, so it isn't limited by this.
 *
 * Instances from axios.create() copy these, so this module has to load before any are made.
 */
export const RESPONSE_MAX_BYTES = 50 * 1024 * 1024;
/** How long a host can go without sending anything. */
export const RESPONSE_TIMEOUT_MS = 30_000;

axios.defaults.maxContentLength = RESPONSE_MAX_BYTES;
axios.defaults.timeout = RESPONSE_TIMEOUT_MS;
