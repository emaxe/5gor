import * as THREE from 'three';
import { clamp, lerp, turnToward } from './utils.js';

const _tempCamDesired = new THREE.Vector3();
const _tempCamLookTarget = new THREE.Vector3();

export class ChaseCamera {
  constructor(camera) {
    this.camera = camera;
    this.targetMode = 'car'; // 'car' | 'ped'
    this.yaw = 0;          // абсолютный угол вокруг объекта
    this.pitch = 0.38;     // высота
    this.isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
    this.dist = this.isTouch ? 11 : 9.5;
    this.targetDist = this.dist;
    this.targetHeight = 0.8;
    this.focusHeight = 0.8;
    this.targetYaw = 0;
    this.autoReturnT = 0;
    if (this.isTouch) { this.pitch = 0.52; }
    this.position = new THREE.Vector3(0, 6, 14);
    this.look = new THREE.Vector3(0, 1, 0);
  }

  /**
   * Переключить режим камеры (машина или пешеход).
   * @param {'car'|'ped'} mode
   */
  setTargetMode(mode) {
    this.targetMode = mode;
    if (mode === 'ped') {
      this.targetDist = this.isTouch ? 4.2 : 3.6;
      this.targetHeight = 1.35;
    } else {
      this.targetDist = this.isTouch ? 11 : 9.5;
      this.targetHeight = 0.8;
    }
  }

  reset(target) {
    this.yaw = target.heading || 0;
    this.targetYaw = target.heading || 0;
    this.pitch = this.isTouch ? 0.52 : 0.38;
    this.dist = this.targetMode === 'ped' ? (this.isTouch ? 4.2 : 3.6) : (this.isTouch ? 11 : 9.5);
    this.targetDist = this.dist;
    this.focusHeight = this.targetMode === 'ped' ? 1.35 : 0.8;
    this.targetHeight = this.focusHeight;
    const gy = target.groundY || 0;
    this.position.set(target.x, gy + 6, target.z + 12);
    this.look.set(target.x, gy + this.focusHeight, target.z);
  }

  /* Вращение/зум из ввода (дельты за кадр) */
  applyInput(input, dt) {
    if (Math.abs(input.camYawDelta) > 0.0001 || Math.abs(input.camPitchDelta) > 0.0001 || Math.abs(input.camZoomDelta) > 0.0001) {
      this.yaw += input.camYawDelta;
      this.pitch = clamp(this.pitch + input.camPitchDelta, 0.12, 1.1);
      const minD = this.targetMode === 'ped' ? 2 : 5;
      const maxD = this.targetMode === 'ped' ? 8 : 16;
      this.dist = clamp(this.dist + input.camZoomDelta, minD, maxD);
      this.targetDist = this.dist;
      this.autoReturnT = 3.0;
    }
    input.camYawDelta = 0;
    input.camPitchDelta = 0;
    input.camZoomDelta = 0;
    // плавный возврат за объект
    if (this.autoReturnT > 0) {
      this.autoReturnT -= dt;
    } else {
      this.yaw = turnToward(this.yaw, this.targetYaw, dt * 0.4);
    }
  }

  update(dt, target) {
    const targetYaw = target.heading || 0;
    // автоцентровка при движении вперёд без ручного вращения
    if (this.autoReturnT <= 0) {
      this.targetYaw = targetYaw;
    }
    // плавный переход дистанции и высоты фокуса при смене режима
    this.dist = lerp(this.dist, this.targetDist, 1 - Math.pow(0.01, dt));
    this.focusHeight = lerp(this.focusHeight, this.targetHeight, 1 - Math.pow(0.01, dt));

    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const gy = target.groundY || 0;
    const camBaseHeight = this.targetMode === 'ped' ? 0.6 : 1.2;
    _tempCamDesired.set(
      target.x - sy * cp * this.dist,
      gy + camBaseHeight + sp * this.dist,
      target.z - cy * cp * this.dist
    );
    this.position.lerp(_tempCamDesired, 1 - Math.pow(0.001, dt));
    _tempCamLookTarget.set(target.x, gy + this.focusHeight, target.z);
    this.look.lerp(_tempCamLookTarget, 1 - Math.pow(0.002, dt));
    this.camera.position.copy(this.position);
    this.camera.lookAt(this.look);
  }
}
