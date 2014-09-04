var _ = require("lodash"),
    initRank = require("./longest-path"),
    feasibleTree = require("./feasible-tree"),
    normalize = require("./normalize"),
    rankUtil = require("./util"),
    components = require("graphlib").alg.components,
    preorder = require("graphlib").alg.preorder,
    postorder = require("graphlib").alg.postorder;

module.exports = networkSimplex;

// Expose some internals for testing purposes
networkSimplex.initLowLimValues = initLowLimValues;
networkSimplex.initCutValues = initCutValues;
networkSimplex.calcCutValue = calcCutValue;
networkSimplex.leaveEdge = leaveEdge;
networkSimplex.enterEdge = enterEdge;
networkSimplex.exchangeEdges = exchangeEdges;

/*
 * The network simplex algorithm assigns ranks to each node in the input graph
 * and iteratively improves the ranking to reduce the length of edges.
 *
 * Preconditions:
 *
 *    1. The input graph must be a DAG.
 *    2. All nodes in the graph must have an object value.
 *    3. All edges in the graph must have "minlen" and "weight" attributes.
 *
 * Postconditions:
 *
 *    1. All nodes in the graph will have an assigned "rank" attribute that has
 *       been optimized by the network simplex algorithm. Ranks start at 0.
 *
 *
 * A rough sketch of the algorithm is as follows:
 *
 *    1. Assign initial ranks to each node. We use the longest path algorithm,
 *       which assigns ranks to the lowest position possible. In general this
 *       leads to very wide bottom ranks and unnecessarily long edges.
 *    2. Construct a feasible tight tree. A tight tree is one such that all
 *       edges in the tree have no slack (difference between length of edge
 *       and minlen for the edge). This by itself greatly improves the assigned
 *       rankings by shorting edges.
 *    3. Iteratively find edges that have negative cut values. Generally a
 *       negative cut value indicates that the edge could be removed and a new
 *       tree edge could be added to produce a more compact graph.
 *
 * Much of the algorithms here are derived from Gansner, et al., "A Technique
 * for Drawing Directed Graphs." The structure of the file roughly follows the
 * structure of the overall algorithm.
 */
function networkSimplex(g) {
  var root = createFakeRoot(g);
  initRank(g);
  var t = feasibleTree(g);
  initLowLimValues(t);
  initCutValues(t, g);

  var e, f;
  while ((e = leaveEdge(t))) {
    f = enterEdge(t, g, e);
    exchangeEdges(t, g, e, f);
  }

  if (root) { g.removeNode(root); }
  normalize(g);
}

/*
 * Creates a fake node to connect all components in the graph. This simplifies
 * some of the algorithms later and also avoids creating subgraphs, which is
 * expensive.
 */
function createFakeRoot(g) {
  var cmpts = components(g);
  if (cmpts.length > 1) {
    var root;
    do {
      root = _.uniqueId("root");
    } while (g.hasNode(root));

    g.setNode(root, {});
    _.each(cmpts, function(cmpt) {
      g.setEdge(root, cmpt[0], { minlen: 0, weight: 0 });
    });

    return root;
  }
}

/*
 * Initializes cut values for all edges in the tree.
 */
function initCutValues(t, g) {
  var vs = postorder(t, t.nodeIds());
  vs = vs.slice(0, vs.length - 1);
  _.each(vs, function(v) {
    assignCutValue(t, g, v);
  });
}

function assignCutValue(t, g, child) {
  var childLab = t.getNode(child),
      parent = childLab.parent;
  t.getEdge(child, parent).cutvalue = calcCutValue(t, g, child);
}

/*
 * Given the tight tree, its graph, and a child in the graph calculate and
 * return the cut value for the edge between the child and its parent.
 */
function calcCutValue(t, g, child) {
  var childLab = t.getNode(child),
      parent = childLab.parent,
      // True if the child is on the tail end of the edge in the directed graph
      childIsTail = true,
      // The graph's view of the tree edge we're inspecting
      graphEdge = g.getEdge(child, parent),
      // The accumulated cut value for the edge between this node and its parent
      cutValue = 0;

  if (!graphEdge) {
    childIsTail = false;
    graphEdge = g.getEdge(parent, child);
  }

  cutValue = graphEdge.weight;

  _.each(g.nodeEdges(child), function(edge) {
    var isOutEdge = edge.v === child,
        other = isOutEdge ? edge.w : edge.v;

    if (other !== parent) {
      var pointsToHead = isOutEdge === childIsTail,
          otherWeight = edge.label.weight;

      cutValue += pointsToHead ? otherWeight : -otherWeight;
      if (isTreeEdge(t, child, other)) {
        var otherCutValue = t.getEdge(child, other).cutvalue;
        cutValue += pointsToHead ? -otherCutValue : otherCutValue;
      }
    }
  });

  return cutValue;
}

function initLowLimValues(tree, root) {
  if (arguments.length < 2) {
    root = tree.nodeIds()[0];
  }
  dfsAssignLowLim(tree, {}, 1, root);
}

// Updates the low and lim numbers for nodes under the root.
function updateLowLim(tree, root) {
  var rootLabel = tree.getNode(root),
      parent = rootLabel.parent,
      visited = {};
  visited[parent] = true;
  dfsAssignLowLim(tree, visited, rootLabel.low, root, parent);
}

function dfsAssignLowLim(tree, visited, nextLim, v, parent) {
  var low = nextLim,
      label = tree.getNode(v);

  visited[v] = true;
  _.each(tree.neighbors(v), function(w) {
    if (!_.has(visited, w)) {
      nextLim = dfsAssignLowLim(tree, visited, nextLim, w, v);
    }
  });

  label.low = low;
  label.lim = nextLim++;
  if (parent) {
    label.parent = parent;
  } else {
    // TODO should be able to remove this when we incrementally update low lim
    delete label.parent;
  }

  return nextLim;
}


function leaveEdge(tree) {
  return _.find(tree.edges(), function(edge) {
    return edge.label.cutvalue < 0;
  });
}

function enterEdge(t, g, edge) {
  var v = edge.v,
      w = edge.w;

  // For the rest of this function we assume that v is the tail and w is the
  // head, so if we don't have this edge in the graph we should flip it to
  // match the correct orientation.
  if (!g.hasEdge(v, w)) {
    v = edge.w;
    w = edge.v;
  }

  var vLabel = t.getNode(v),
      wLabel = t.getNode(w),
      tailLabel = vLabel,
      flip = false;

  // If the root is in the tail of the edge then we need to flip the logic that
  // checks for the head and tail nodes in the candidates function below.
  if (vLabel.lim > wLabel.lim) {
    tailLabel = wLabel;
    flip = true;
  }

  var candidates = _.filter(g.edges(), function(edge) {
    return flip === isDescendant(t, t.getNode(edge.v), tailLabel) &&
           flip !== isDescendant(t, t.getNode(edge.w), tailLabel);
  });

  return _.min(candidates, function(edge) { return rankUtil.slack(g, edge); });
}

function exchangeEdges(t, g, e, f) {
  var v = e.v,
      w = e.w,
      lca = findLCA(t, v, w);
  t.removeEdge(v, w);
  t.setEdge(f.v, f.w, {});
  initLowLimValues(t);
  initCutValues(t, g);
  updateRanks(t, g);
  /*
  updateLowLim(tree, lca);
  updateCutValues(tree, g, v, lca);
  updateCutValues(tree, g, w, lca);
  */
}

function updateRanks(t, g) {
  var root = _.find(t.nodes(), function(node) { return !node.label.parent; }),
      vs = preorder(t, root.v);
  vs = vs.slice(1);
  _.each(vs, function(v) {
    var parent = t.getNode(v).parent,
        edge = g.getEdge(v, parent),
        flipped = false;

    if (!edge) {
      edge = g.getEdge(parent, v);
      flipped = true;
    }

    g.getNode(v).rank = g.getNode(parent).rank + (flipped ? edge.minlen : -edge.minlen);
  });
}

function updateCutValues(tree, g, v, lca) {
  var parent;
  while (v !== lca) {
    parent = tree.getNode(v).parent;
    assignCutValue(tree, g, v);
    v = parent;
  }
}

function findLCA(tree, v, w) {
  var vLabel = tree.getNode(v),
      wLabel = tree.getNode(w),
      low = Math.min(vLabel.low, wLabel.low),
      lim = Math.max(vLabel.lim, wLabel.lim),
      lca = v,
      lcaLabel = vLabel;
  while (lcaLabel.low > low || lcaLabel.lim < lim) {
    lca = lcaLabel.parent;
    lcaLabel = tree.getNode(lca);
  }
  return lca;
}

/*
 * Returns true if the edge is in the tree.
 */
function isTreeEdge(tree, u, v) {
  return tree.hasEdge(u, v);
}

/*
 * Returns true if the specified node is descendant of the root node per the
 * assigned low and lim attributes in the tree.
 */
function isDescendant(tree, vLabel, rootLabel) {
  return rootLabel.low <= vLabel.lim && vLabel.lim <= rootLabel.lim;
}