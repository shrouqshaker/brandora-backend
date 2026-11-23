const {
  controllerRoutes,
  verifyRoutePolicy,
  verifyControllerInventory,
} = require('./controller-route-inventory.cjs');

const routes = controllerRoutes();
test.each(routes)(
  '$verb $route has the reviewed compiled authorization policy',
  (route) => {
    verifyRoutePolicy(route);
  },
);
test('compiled inventory contains 67 routes, 58 protected including internal AI and nine public', () => {
  expect(verifyControllerInventory(routes)).toEqual({
    routes: 67,
    protected: 58,
    public: 9,
    mismatches: 0,
  });
});
