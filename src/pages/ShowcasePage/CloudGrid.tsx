const CloudGrid = () => (
  <gridHelper 
    args={[8, 16, 0x444444, 0x222222]} 
    position={[0, 1.5, 0]} 
  >
    <meshBasicMaterial transparent opacity={0.25} />
  </gridHelper>
);

export default CloudGrid;
