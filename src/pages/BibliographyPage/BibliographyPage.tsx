import { NavigationIcons } from '../../components/Navigation';
import './BibliographyPage.css';

const BibliographyPage = () => {
  return (
    <div className="bibliography-page">
      <h1>Lightning Simulation Bibliography</h1>
      <p className="intro">
        Resources and references used in the development of our lightning simulation algorithm.
      </p>

      <div className="bibliography-content">
        <h2>Scientific Resources</h2>
        <ul>
          <li>
            <a href="https://www.nssl.noaa.gov/education/svrwx101/lightning/" target="_blank" rel="noopener noreferrer">
              National Severe Storms Laboratory: Lightning
            </a>
            <p>Comprehensive information about the physics of cloud-to-ground lightning and its formation.</p>
          </li>
          <li>
            <a href="https://scied.ucar.edu/learning-zone/storms/lightning" target="_blank" rel="noopener noreferrer">
              UCAR Center for Science Education: Lightning
            </a>
            <p>Educational resources explaining how lightning forms through the stepwise process of leader development and return strokes.</p>
          </li>
          <li>
            <a href="https://www.weather.gov/safety/lightning-science-return-stroke-dart-leaders" target="_blank" rel="noopener noreferrer">
              NOAA Weather: Return Strokes &amp; Dart Leaders
            </a>
            <p>Details on the return strokes and subsequent dart leaders that cause the characteristic flicker in lightning strikes.</p>
          </li>
        </ul>

        <h2>Technical Implementations</h2>
        <ul>
          <li>
            <a href="https://sgga.kaist.ac.kr/publication/papers/2017-ToG-LightningGodController/paper.html" target="_blank" rel="noopener noreferrer">
              KAIST: The Lightning-God Controller
            </a>
            <p>Research on the Dielectric Breakdown Model (DBM) for visually realistic lightning simulation, including details on branch angle distribution (~16°) and fractal properties.</p>
          </li>
          <li>
            <a href="https://gamma.cs.unc.edu/LIGHTNING/" target="_blank" rel="noopener noreferrer">
              UNC GAMMA: Real-Time Lightning Simulation and Rendering
            </a>
            <p>Information on fractal dimension (~1.7) of lightning discharge networks and techniques for visually simulating lightning paths.</p>
          </li>
          <li>
            <a href="https://en.wikipedia.org/wiki/Lichtenberg_figure" target="_blank" rel="noopener noreferrer">
              Wikipedia: Lichtenberg Figures
            </a>
            <p>Description of the branching discharge patterns in insulators that share similar fractal properties with lightning.</p>
          </li>
          <li>
            <a href="https://www.krazydad.com/blog/2014/09/midpoint-displacement-and-jaggies/" target="_blank" rel="noopener noreferrer">
              KrazyDad: Midpoint Displacement Algorithm
            </a>
            <p>Tutorial on the midpoint displacement method, a fractal algorithm that can be used to generate jagged lines resembling lightning paths.</p>
          </li>
        </ul>

        <h2>Modeling Approaches</h2>
        <ul>
          <li>
            <strong>Fractal Subdivision Methods</strong>
            <p>Techniques that recursively subdivide line segments and apply random displacements to create jagged paths with natural-looking properties.</p>
          </li>
          <li>
            <strong>Dielectric Breakdown Model (DBM)</strong>
            <p>Physics-based approach that simulates how lightning follows electric field lines between cloud and ground charges, creating branched patterns with realistic fractal dimensions.</p>
          </li>
          <li>
            <strong>Stochastic L-Systems</strong>
            <p>Grammar-based procedural generation techniques that can create branching structures with controlled randomness.</p>
          </li>
        </ul>
      </div>

      <NavigationIcons currentPage="bibliography" />
    </div>
  );
};

export default BibliographyPage;
