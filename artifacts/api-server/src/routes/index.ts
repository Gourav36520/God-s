import { Router, type IRouter } from "express";
import healthRouter from "./health";
import verificationAdminRouter from "./verification/admin";
import verificationRouter from "./verification/index";

const router: IRouter = Router();

router.use(healthRouter);
router.use(verificationRouter);
router.use(verificationAdminRouter);

export default router;
