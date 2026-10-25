import { Router, type IRouter } from "express";
import healthRouter from "./health";
import verificationAdminRouter from "./verification/admin";

const router: IRouter = Router();

router.use(healthRouter);
router.use(verificationAdminRouter);

export default router;
