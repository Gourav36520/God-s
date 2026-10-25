import { Router, type IRouter } from "express";
import healthRouter from "./health";
import verificationRouter from "./verification/index";

const router: IRouter = Router();

router.use(healthRouter);
router.use(verificationRouter);

export default router;
