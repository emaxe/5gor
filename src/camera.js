import * as THREE from 'three';
import { clamp, turnToward } from './utils.js';

const _tempCamDesired = new THREE.Vector3();
const _tempCamLookTarget = new THREE.Vector3();

export class ChaseCamera {
  constructor(camera) {
    this.camera = camera;
    this.yaw = 0;          // абсолютный угол вокруг машины
    this.pitch = 0.38;     // высота
    this.dist = 9.5;
    this.targetYaw = 0;
    this.autoReturnT = 0;
    this.isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
    if (this.isTouch) { this.pitch = 0.52; this.dist = 11; }
    this.position = new THREE.Vector3(0, 6, 14);
    this.look = new THREE.Vector3(0, 1, 0);
  }

  reset(car) {
    this.yaw = car.heading;
    this.targetYaw = car.heading;
    this.pitch = this.isTouch ? 0.52 : 0.38;
    this.dist = this.isTouch ? 11 : 9.5;
    this.position.set(car.x, 6, car.z + 12);
    this.look.set(car.x, 1, car.z);
  }

  /* Вращение/зум из ввода (дельты за кадр) */
  applyInput(input, dt) {
    if (Math.abs(input.camYawDelta) > 0.0001 || Math.abs(input.camPitchDelta) > 0.0001 || Math.abs(input.camZoomDelta) > 0.0001) {
      this.yaw += input.camYawDelta;
      this.pitch = clamp(this.pitch + input.camPitchDelta, 0.12, 1.1);
      this.dist = clamp(this.dist + input.camZoomDelta, 5, 16);
      this.autoReturnT = 3.0;
    }
    input.camYawDelta = 0;
    input.camPitchDelta = 0;
    input.camZoomDelta = 0;
    // плавный возврат за машину
    if (this.autoReturnT > 0) {
      this.autoReturnT -= dt;
    } else {
      this.yaw = turnToward(this.yaw, this.targetYaw, dt * 0.4);
    }
  }

  update(dt, car) {
    const targetYaw = car.heading;
    // автоцентровка при движении вперёд без ручного вращения
    if (this.autoReturnT <= 0) {
      this.targetYaw = targetYaw;
    }
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    _tempCamDesired.set(
      car.x - sy * cp * this.dist,
      car.groundY + 1.2 + sp * this.dist,
      car.z - cy * cp * this.dist
    );
    this.position.lerp(_tempCamDesired, 1 - Math.pow(0.001, dt));
    _tempCamLookTarget.set(car.x, car.groundY + 0.8, car.z);
    this.look.lerp(_tempCamLookTarget, 1 - Math.pow(0.002, dt));
    this.camera.position.copy(this.position);
    this.camera.lookAt(this.look);
  }
}
