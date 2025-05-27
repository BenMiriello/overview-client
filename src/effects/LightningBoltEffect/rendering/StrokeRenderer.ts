import * as THREE from 'three';
import { ReturnStrokeSegment } from '../physics';

export class StrokeRenderer {
  private group: THREE.Group;
  private mainMaterial: THREE.LineBasicMaterial;
  private glowMaterial: THREE.LineBasicMaterial;
  
  constructor() {
    this.group = new THREE.Group();
    
    this.mainMaterial = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 1.0,
      linewidth: 3
    });
    
    this.glowMaterial = new THREE.LineBasicMaterial({
      color: 0xaaccff,
      transparent: true,
      opacity: 0.5,
      linewidth: 8
    });
  }
  
  render(stroke: ReturnStrokeSegment, flashIntensity: number = 0): THREE.Group {
    this.clear();
    
    if (stroke.points.length < 2) return this.group;
    
    const points = stroke.points.map(p => new THREE.Vector3(p.x, p.y, p.z));
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    
    const glowLine = new THREE.Line(geometry.clone(), this.glowMaterial.clone());
    glowLine.renderOrder = 1001;
    this.group.add(glowLine);
    
    const mainLine = new THREE.Line(geometry, this.mainMaterial.clone());
    mainLine.renderOrder = 1002;
    
    if (flashIntensity > 0) {
      (mainLine.material as THREE.LineBasicMaterial).opacity = Math.min(1.0, 0.8 + flashIntensity * 0.2);
      (mainLine.material as THREE.LineBasicMaterial).color = new THREE.Color(
        1.0,
        1.0 - flashIntensity * 0.1,
        1.0 - flashIntensity * 0.2
      );
      
      (glowLine.material as THREE.LineBasicMaterial).opacity = Math.min(0.8, 0.3 + flashIntensity * 0.5);
    }
    
    this.group.add(mainLine);
    
    return this.group;
  }
  
  clear(): void {
    while (this.group.children.length > 0) {
      const child = this.group.children[0];
      if (child instanceof THREE.Line) {
        child.geometry.dispose();
        if (child.material instanceof THREE.Material) {
          child.material.dispose();
        }
      }
      this.group.remove(child);
    }
  }
  
  dispose(): void {
    this.clear();
    this.mainMaterial.dispose();
    this.glowMaterial.dispose();
  }
}
