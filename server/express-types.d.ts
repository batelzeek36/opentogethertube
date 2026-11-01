import { User as UserAccount } from "./models/user";
import { AuthToken } from "ott-common/models/types.js";
import { SessionInfo } from "./auth/tokens";
import * as core from "express-serve-static-core";

declare module "express/lib/router/layer.js" {
	import type { NextFunction, Request, Response } from "express";

	class Layer {
		handle: (...args: any[]) => unknown;
		handle_request(req: Request, res: Response, next: NextFunction): void;
		handle_error(error: unknown, req: Request, res: Response, next: NextFunction): void;
	}
	export default Layer;
}

declare global {
	namespace Express {
		export interface Request {
			token?: AuthToken;
			ottsession?: SessionInfo;
			user?: UserAccount;
		}

		// export interface RequestHandler<
		// 	P = ParamsDictionary,
		// 	ResBody = OttResponseBody | OttStaticDataResponseBody,
		// 	ReqBody = any,
		// 	ReqQuery = qs.ParsedQs,
		// 	Locals extends Record<string, any> = Record<string, any>
		// > {
		// 	(
		// 		req: Request<P, ResBody, ReqBody, ReqQuery, Locals>,
		// 		res: Response<ResBody, Locals>,
		// 		next: NextFunction,
		// 	): void | Promise<void>;
		// }
	}
}
