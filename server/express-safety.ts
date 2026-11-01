import type { ErrorRequestHandler, NextFunction } from "express";
import Layer from "express/lib/router/layer.js";
import { getLogger } from "./logger.js";
import { counterHttpErrors } from "./metrics.js";

const log = getLogger("express-safety");

function forwardRejection(result: unknown, next: NextFunction): void {
	if (typeof (result as PromiseLike<unknown> | undefined)?.then === "function") {
		(result as PromiseLike<unknown>).then(undefined, err => {
			next(err ?? new Error("A request handler rejected without saying why"));
		});
	}
}

/**
 * Express 4 ignores what a handler returns, so a rejected async handler is an unhandled rejection,
 * and Node exits on those: one bad request would end the movie for every room on this server.
 * Express 5 sends these to the error handlers by itself. Until the server moves to it, this does the
 * same for every route and middleware, including ones nobody has written yet. These are Express's own
 * two methods with the return value looked at; tests/unit/express-safety.spec.ts fails if an Express
 * upgrade stops calling them.
 */
export function sendRejectionsToErrorHandlers(): void {
	Layer.prototype.handle_request = function (req, res, next) {
		const fn = this.handle;
		if (fn.length > 3) {
			next();
			return;
		}
		try {
			forwardRejection(fn(req, res, next), next);
		} catch (err) {
			next(err);
		}
	};
	Layer.prototype.handle_error = function (error, req, res, next) {
		const fn = this.handle;
		if (fn.length !== 4) {
			next(error);
			return;
		}
		try {
			forwardRejection(fn(error, req, res, next), next);
		} catch (err) {
			next(err);
		}
	};
}

/** The status of an error the client caused, like a body that is not JSON or a path that won't decode. */
function clientErrorStatus(err: { status?: unknown }): number | undefined {
	const { status } = err;
	return typeof status === "number" && status >= 400 && status < 500 ? status : undefined;
}

/**
 * The last thing every request can reach, so it must go after every route. Routes answer their own
 * errors when they can. This answers the rest, and never answers twice.
 */
export const lastResortErrorHandler: ErrorRequestHandler = (thrown, req, res, _next) => {
	const err: Error & { status?: unknown; expose?: unknown } =
		thrown instanceof Error ? thrown : new Error(String(thrown));
	counterHttpErrors.labels({ error: err.name }).inc();

	const status = clientErrorStatus(err);
	if (status === undefined) {
		log.error(`Unhandled exception: path=${req.path} ${err.name} ${err.message} ${err.stack}`);
	} else {
		log.debug(`Bad request: path=${req.path} ${err.name} ${err.message}`);
	}

	if (res.headersSent) {
		// The answer has started, so it can't become an error now. All that's left is to not leave a
		// half finished one hanging.
		if (!res.writableEnded) {
			res.destroy();
		}
		return;
	}
	if (status === undefined) {
		res.status(500).json({
			success: false,
			error: {
				name: "Unknown",
				message: "An unknown error occurred. Try again later.",
			},
		});
		return;
	}
	res.status(status).json({
		success: false,
		error: {
			name: err.name,
			message: err.expose ? err.message : "Bad request.",
		},
	});
};
