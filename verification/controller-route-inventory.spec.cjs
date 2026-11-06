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
test('compiled inventory contains 51 routes, 44 protected including internal AI and seven public', () => {
  expect(verifyControllerInventory(routes)).toEqual({
    routes: 51,
    protected: 44,
    public: 7,
    mismatches: 0,
  });
});
