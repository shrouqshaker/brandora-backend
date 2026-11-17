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
test('compiled inventory contains 65 routes, 56 protected including internal AI and nine public', () => {
  expect(verifyControllerInventory(routes)).toEqual({
    routes: 65,
    protected: 56,
    public: 9,
    mismatches: 0,
  });
});
