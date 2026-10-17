import { Router } from "express";
import callbackRouter from "./callback";
import consentRouter from "./consent";
import sessionsRouter from "./sessions";

const router = Router();

router.use(sessionsRouter);
router.use(consentRouter);
router.use(callbackRouter);

export default router;
